// Uploads to Shopify Files (ARCHITECTURE §5, §7): the popup's font and a
// chart's How to measure image. A staged upload, fileCreate, then the file's
// cdn.shopify.com address once Shopify has it. Fitted passes the file on and
// never serves it.
import { FONT_URL } from "../lib/appearance";
import { type Admin, AdminApiError, adminGraphql } from "./admin.server";

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

/** Uploads a checked file; answers its Files id and cdn.shopify.com URL. */
async function upload(admin: Admin, kind: keyof typeof KINDS, file: Upload) {
  const { op, resource, type } = KINDS[kind];
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
  for (const end = Date.now() + WAIT_MS; ; await sleep(500)) {
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
    if (node?.fileStatus === "READY" && url && FONT_URL.test(url))
      return { id, url };
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
export const uploadFont = async (admin: Admin, file: Upload) =>
  (await upload(admin, "font", file)).url;
/** Uploads a checked PNG or JPG; answers the MediaImage id and its URL. */
export const uploadImage = (admin: Admin, file: Upload) =>
  upload(admin, "image", file);
