// Uploads to Shopify Files (ARCHITECTURE §5, §7): the popup's font and a
// chart's How to measure image. A staged upload, fileCreate, then the file's
// cdn.shopify.com address once Shopify has it. Fitted passes the file on and
// never serves it.
import { createHmac, timingSafeEqual } from "node:crypto";
import { FONT_URL } from "../lib/appearance";
import {
  type Admin,
  AdminApiError,
  type UserError,
  adminGraphql,
} from "./admin.server";
import { chartPages } from "./chart.server";

const WAIT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Target = {
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
};
type Node = {
  fileStatus?: string;
  url?: string | null;
  image?: { url: string } | null;
} | null;
type Upload = { name: string; mime: string; bytes: Uint8Array<ArrayBuffer> };

// Named for what it carries, so its operations and logs say which.
const KINDS = {
  font: { op: "Font", resource: "FILE", type: "GenericFile" },
  image: { op: "Image", resource: "IMAGE", type: "MediaImage" },
} as const;

/**
 * Uploads a checked file; answers its Files id and cdn.shopify.com URL.
 * `signal` is the screen's request: once it stops waiting, no file is kept.
 */
async function upload(
  admin: Admin,
  kind: keyof typeof KINDS,
  file: Upload,
  signal?: AbortSignal,
) {
  const { op, resource } = KINDS[kind];
  const dropped = () => {
    if (signal?.aborted)
      throw new AdminApiError(`The ${kind} upload was dropped`, "aborted");
  };
  const filename = file.name.replace(/[^\w.-]+/g, "-").slice(-100);
  const { stagedUploadsCreate } = await adminGraphql<{
    stagedUploadsCreate: { stagedTargets: Target[] };
  }>(
    admin,
    `#graphql
    mutation Fitted${op}Stage($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          resource,
          filename,
          mimeType: file.mime,
          httpMethod: "POST",
          fileSize: String(file.bytes.length),
        },
      ],
    },
    { retry: true },
  );
  const [target] = stagedUploadsCreate.stagedTargets;
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  // The file goes last, after the fields that sign the upload.
  form.append("file", new Blob([file.bytes], { type: file.mime }), filename);
  const res = await fetch(target.url, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => `${e?.name}`);
  if (typeof res === "string" || !res.ok)
    throw new AdminApiError(
      `The ${kind} didn't reach Shopify`,
      typeof res === "string" ? res : `HTTP ${res.status}`,
    );

  dropped();
  // Not retried: a second fileCreate would add a second file.
  const { fileCreate } = await adminGraphql<{
    fileCreate: { files: { id: string }[] };
  }>(
    admin,
    `#graphql
    mutation Fitted${op}Create($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus }
        userErrors { field message code }
      }
    }`,
    {
      files: [{ originalSource: target.resourceUrl, contentType: resource }],
    },
  );
  const { id } = fileCreate.files[0];
  try {
    const url = await ready(admin, kind, id, dropped);
    dropped();
    return { id, url };
  } catch (err) {
    // A file the merchant was told didn't upload is deleted. Only the one
    // this upload just made is ever deleted. (A lost session can't delete.)
    if (!(err instanceof AdminApiError)) throw err;
    await adminGraphql(
      admin,
      `#graphql
      mutation Fitted${op}Drop($ids: [ID!]!) {
        fileDelete(fileIds: $ids) { deletedFileIds userErrors { field message code } }
      }`,
      { ids: [id] },
    ).catch((e) => {
      if (!(e instanceof AdminApiError)) throw e;
      throw new AdminApiError(
        `Shopify didn't delete the dropped ${kind}`,
        `${e.detail}; first: ${err.message}`,
      );
    });
    throw err;
  }
}

/** Waits for Shopify to finish the file; answers its cdn.shopify.com URL. */
async function ready(
  admin: Admin,
  kind: keyof typeof KINDS,
  id: string,
  dropped: () => void,
) {
  const { op, type } = KINDS[kind];
  for (const end = Date.now() + WAIT_MS; ; await sleep(500)) {
    dropped();
    const { node } = await adminGraphql<{ node: Node }>(
      admin,
      `#graphql
      query Fitted${op}File($id: ID!) {
        node(id: $id) { ... on ${type} { fileStatus ${kind === "image" ? "image { url }" : "url"} } }
      }`,
      { id },
      { retry: true },
    );
    const url = node?.url ?? node?.image?.url;
    if (node?.fileStatus === "READY" && url && FONT_URL.test(url)) return url;
    if (node?.fileStatus === "READY" || node?.fileStatus === "FAILED")
      throw new AdminApiError(`Shopify didn't keep the ${kind}`, `${url}`);
    if (Date.now() > end)
      throw new AdminApiError(
        `The ${kind} took too long`,
        `${node?.fileStatus}`,
      );
  }
}

/**
 * The `file` of an upload form, reading at most `max` bytes of the body:
 * "size" past that, null without a file.
 */
export async function readFile(request: Request, max: number) {
  let seen = 0;
  const cap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      seen += chunk.byteLength;
      if (seen > max) c.error(new Error("Too large"));
      else c.enqueue(chunk);
    },
  });
  const headers = { "content-type": request.headers.get("content-type")! };
  const form = await new Response(request.body?.pipeThrough(cap), { headers })
    .formData()
    .catch(() => null);
  if (seen > max) return "size" as const;
  const file = form?.get("file");
  return file instanceof File ? file : null;
}

/** Uploads a checked font file and returns its Shopify Files URL. */
export const uploadFont = async (
  admin: Admin,
  file: Upload,
  signal?: AbortSignal,
) => (await upload(admin, "font", file, signal)).url;
// Proof that Fitted uploaded a file for this shop at second `t`, so a discard
// never deletes a file the merchant or another app made. Only image uploads
// are signed: a font upload gets none, so the store's font can't be discarded.
const SIG_MAX_AGE = 60 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);
function sign(shop: string, id: string, t: number) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("SHOPIFY_API_SECRET is not set");
  const mac = createHmac("sha256", secret)
    .update(`fitted-discard ${shop} ${id} ${t}`)
    .digest("base64url");
  return `${t}.${mac}`;
}

/** Uploads a checked PNG or JPG; answers its MediaImage id, URL and `sig`. */
export async function uploadImage(admin: Admin, shop: string, file: Upload) {
  const image = await upload(admin, "image", file);
  return { ...image, sig: sign(shop, image.id, nowSeconds()) };
}

/**
 * Deletes an image this shop's editor uploaded within the hour and no chart
 * saved. Without a call to Shopify, "not_fitted" when `sig` isn't the one its
 * upload answered and "expired" past the hour; "saved" when a chart holds it.
 */
export async function discardImage(
  admin: Admin,
  shop: string,
  id: string,
  sig: string,
) {
  const t = Number(/^\d{1,12}(?=\.)/.exec(sig)?.[0]);
  const want = Buffer.from(t ? sign(shop, id, t) : "");
  const got = Buffer.from(sig);
  if (!t || got.length !== want.length || !timingSafeEqual(got, want))
    return "not_fitted";
  if (nowSeconds() - t > SIG_MAX_AGE) return "expired";
  // Any chart, a clone's included, and one that doesn't read in full.
  for await (const charts of chartPages(admin))
    if (charts.some((c) => (c.chart ?? c.raw).measureImage === id))
      return "saved";
  await adminGraphql(
    admin,
    `#graphql
    mutation FittedImageDelete($ids: [ID!]!) {
      fileDelete(fileIds: $ids) {
        deletedFileIds
        userErrors { field message code }
      }
    }`,
    { ids: [id] },
    { retry: true },
  ).catch((err) => {
    // Already gone: a retry after the first delete landed, or the merchant's.
    const gone = (e: UserError) => e.code === "FILE_DOES_NOT_EXIST";
    const { userErrors = [] } = err instanceof AdminApiError ? err : {};
    if (!userErrors.length || !userErrors.every(gone)) throw err;
  });
  return "discarded";
}
