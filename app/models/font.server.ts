// The popup's uploaded font (ARCHITECTURE §7): a staged upload to Shopify
// Files, fileCreate, then its cdn.shopify.com address once Shopify has it.
// Fitted passes the file on and never serves it.
import { FONT_URL } from "../lib/appearance";
import { type Admin, AdminApiError, adminGraphql } from "./admin.server";

const WAIT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Target = {
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
};
type Node = { fileStatus?: string; url?: string | null } | null;

/** Uploads a checked font file and returns its Shopify Files URL. */
export async function uploadFont(
  admin: Admin,
  file: { name: string; mime: string; bytes: Uint8Array<ArrayBuffer> },
) {
  const filename = file.name.replace(/[^\w.-]+/g, "-").slice(-100);
  const { stagedUploadsCreate } = await adminGraphql<{
    stagedUploadsCreate: { stagedTargets: Target[] };
  }>(
    admin,
    `#graphql
    mutation FittedFontStage($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          resource: "FILE",
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
      "The font didn't reach Shopify",
      typeof res === "string" ? res : `HTTP ${res.status}`,
    );

  // Not retried: a second fileCreate would add a second file.
  const { fileCreate } = await adminGraphql<{
    fileCreate: { files: { id: string }[] };
  }>(
    admin,
    `#graphql
    mutation FittedFontCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus }
        userErrors { field message code }
      }
    }`,
    { files: [{ originalSource: target.resourceUrl, contentType: "FILE" }] },
  );
  const { id } = fileCreate.files[0];
  for (const end = Date.now() + WAIT_MS; ; await sleep(500)) {
    const { node } = await adminGraphql<{ node: Node }>(
      admin,
      `#graphql
      query FittedFontFile($id: ID!) {
        node(id: $id) { ... on GenericFile { fileStatus url } }
      }`,
      { id },
      { retry: true },
    );
    if (node?.fileStatus === "READY" && node.url && FONT_URL.test(node.url))
      return node.url;
    if (node?.fileStatus === "READY" || node?.fileStatus === "FAILED")
      throw new AdminApiError("Shopify didn't keep the font", `${node.url}`);
    if (Date.now() > end)
      throw new AdminApiError("The font took too long", `${node?.fileStatus}`);
  }
}
