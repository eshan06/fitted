// The popup font on the Appearance board: the Font select, then choose a file,
// uploading, uploaded (Replace, Remove), not a font file, too large, and
// didn't upload. The file is checked here and again by the route's action.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";
import { FONT_MAX, FONT_WORDS, fileSize, fontType } from "../../lib/appearance";

export const FONT_FAILED =
  "Shopify didn't answer, so the popup still uses your theme's font.";
type Font = "theme" | { fileUrl: string };
type Answer = { fileUrl?: string; fieldErrors?: Record<string, string> };
type View = "choose" | "type" | "size" | "failed";
// Files uploaded in this visit, by URL: their names and sizes outlast the
// reload after a save. Otherwise the name comes from the URL.
const uploaded = new Map<string, File>();
const nameOf = (url: string) => new URL(url).pathname.split("/").pop();

export function useFontUpload(font: Font, put: (v: Font) => void) {
  const uploader = useFetcher<Answer>();
  const input = useRef<HTMLInputElement>(null);
  // The answer on hand when the file was sent, so only a newer one counts;
  // null once nothing is awaited. Match my theme, Remove or Discard while it
  // uploads drops the upload.
  const sentOver = useRef<{ answer?: Answer } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [file, setFile] = useState<File>();
  const sending = uploader.state !== "idle" && !!sentOver.current;

  useEffect(() => {
    const a = uploader.data;
    const old = sentOver.current;
    if (uploader.state !== "idle" || !old || !a || a === old.answer || !file)
      return;
    sentOver.current = null;
    if (a.fileUrl) {
      uploaded.set(a.fileUrl, file);
      put({ fileUrl: a.fileUrl });
      setView(null);
    } else if (a.fieldErrors)
      setView(
        a.fieldErrors["popup.font"] === FONT_WORDS.size ? "size" : "type",
      );
    else setView("failed");
    // `put` is new on every render; the check above keeps this to one run per answer.
  }, [uploader.state, uploader.data, file, put]);

  const send = (f: File) => {
    setView(null);
    sentOver.current = { answer: uploader.data };
    const form = new FormData();
    form.append("file", f);
    uploader.submit(form, { method: "post", encType: "multipart/form-data" });
  };
  // A picked file takes the old font's place, uploaded or not.
  const pick = async (f?: File) => {
    if (!f) return;
    put("theme");
    setFile(f);
    const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
    if (!fontType(f.name, head)) setView("type");
    else if (f.size > FONT_MAX) setView("size");
    else send(f);
  };
  const reset = (v: View | null = null) => {
    sentOver.current = null;
    setView(v);
  };

  const add = (label: string) => (
    <s-button onClick={() => input.current?.click()}>{label}</s-button>
  );
  const alert = (title: string, line: string, action: ReactNode) => (
    <div role="alert" className="font-drop bad">
      <s-icon type="alert-circle" tone="critical" />
      <strong>{title}</strong>
      <span>{line}</span>
      {action}
    </div>
  );
  const name = file?.name;
  let box: ReactNode = null;
  if (sending)
    box = (
      <div role="status" className="font-drop">
        <s-spinner accessibilityLabel="Uploading" />
        <strong>Uploading {name}</strong>
        <span className="bar" aria-hidden="true">
          <span />
        </span>
      </div>
    );
  else if (view === "choose")
    box = (
      <div
        className="font-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pick(e.dataTransfer.files[0]);
        }}
      >
        {add("Add font file")}
        <span className="help">
          or drop it here. WOFF2, WOFF, TTF or OTF, up to 2 MB.
        </span>
      </div>
    );
  else if (view === "type")
    box = alert(
      `${name} isn't a font file`,
      FONT_WORDS.type,
      add("Add font file"),
    );
  else if (view === "size")
    box = alert(
      `${name} is ${fileSize(file!.size)}`,
      FONT_WORDS.size,
      add("Add font file"),
    );
  else if (view === "failed")
    box = alert(
      `${name} didn't upload`,
      FONT_FAILED,
      <s-button onClick={() => send(file!)}>Try again</s-button>,
    );
  else if (font !== "theme") {
    const f = uploaded.get(font.fileUrl);
    box = (
      <div className="font-file">
        <span className="aa" aria-hidden="true">
          Aa
        </span>
        <div>
          <strong>{f?.name ?? nameOf(font.fileUrl)}</strong>
          <span className="help">
            {f
              ? `${fileSize(f.size)}, saved in your Shopify Files`
              : "Saved in your Shopify Files"}
          </span>
        </div>
        <div className="row">
          {add("Replace")}
          <s-button
            onClick={() => {
              put("theme");
              reset();
            }}
          >
            Remove
          </s-button>
        </div>
      </div>
    );
  }

  const select = (
    <label>
      Font
      <select
        className="field"
        value={font !== "theme" || view || sending ? "upload" : "theme"}
        onChange={(e) => {
          if (e.target.value === "upload") return reset("choose");
          put("theme");
          reset();
        }}
      >
        <option value="theme">Match my theme</option>
        <option value="upload">Upload a font</option>
      </select>
    </label>
  );
  return {
    select,
    box: (
      <>
        <input
          ref={input}
          type="file"
          accept=".woff2,.woff,.ttf,.otf"
          hidden
          aria-label="Font file"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {box}
      </>
    ),
    reset: () => reset(),
  };
}
