// The Editor board's How to measure tab: the drawing (add, uploading,
// uploaded with Replace and Remove, not a PNG or JPG, didn't upload) and the
// numbered steps. The file is checked here and again by the route's action,
// then goes to Shopify Files; the chart holds it once the editor saves.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";
import { IMAGE_MAX, imageType } from "../../lib/image-file";
import * as model from "./model";

type Answer = {
  image?: { id: string; url: string };
  error?: { code: string };
};
// Images seen in this visit, by Files id: their address and name outlast a
// save's reload. A stored one's name comes from its address.
const shown = new Map<string, { url: string; name: string }>();
const nameOf = (url: string) =>
  decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");

export function useMeasureImage(
  image: string | undefined,
  storedUrl: string | undefined,
  put: (id: string | undefined) => void,
) {
  if (image && storedUrl && !shown.has(image))
    shown.set(image, { url: storedUrl, name: nameOf(storedUrl) });
  const uploader = useFetcher<Answer>();
  const input = useRef<HTMLInputElement>(null);
  // The answer on hand when the file was sent, so only a newer one counts;
  // null once nothing is awaited, as after Remove or Discard.
  const sentOver = useRef<{ answer?: Answer } | null>(null);
  const [view, setView] = useState<"type" | "failed" | null>(null);
  const [file, setFile] = useState<File>();
  const sending = uploader.state !== "idle" && !!sentOver.current;

  useEffect(() => {
    const a = uploader.data;
    const old = sentOver.current;
    if (uploader.state !== "idle" || !old || !a || a === old.answer || !file)
      return;
    sentOver.current = null;
    if (a.image) {
      shown.set(a.image.id, { url: a.image.url, name: file.name });
      put(a.image.id);
    } else setView(a.error?.code === "image" ? "type" : "failed");
    // `put` is new on every render; the check above keeps this to one run per answer.
  }, [uploader.state, uploader.data, file, put]);

  // ponytail: an image over 20 MB shows "didn't upload" until its own state is drawn.
  const pick = async (f?: File) => {
    if (!f) return;
    setFile(f);
    setView(null);
    const head = new Uint8Array(
      await f
        .slice(0, 8)
        .arrayBuffer()
        .catch(() => new ArrayBuffer(0)),
    );
    if (!imageType(f.name, head)) return setView("type");
    if (f.size > IMAGE_MAX) return setView("failed");
    sentOver.current = { answer: uploader.data };
    const form = new FormData();
    form.append("file", f);
    uploader.submit(form, { method: "post", encType: "multipart/form-data" });
  };
  const add = (label: string) => (
    <s-button onClick={() => input.current?.click()}>{label}</s-button>
  );
  const alert = (title: string, line: string, action: ReactNode) => (
    <div role="alert" className="drop bad">
      <s-icon type="alert-circle" tone="critical" />
      <strong>{title}</strong>
      <span>{line}</span>
      {action}
    </div>
  );
  const at = image ? shown.get(image) : undefined;
  let box: ReactNode;
  if (sending)
    box = (
      <div role="status" className="drop">
        <s-spinner accessibilityLabel="Uploading" />
        <strong>Uploading {file?.name}</strong>
        <span className="bar" aria-hidden="true">
          <span />
        </span>
      </div>
    );
  else if (view === "type")
    box = alert(
      `${file?.name} isn't a PNG or JPG`,
      "Save it as one and add it again.",
      add("Add image"),
    );
  else if (view === "failed")
    box = alert(
      `${file?.name} didn't upload`,
      "Shopify didn't answer, so the chart has no drawing yet.",
      <s-button onClick={() => pick(file)}>Try again</s-button>,
    );
  else if (image)
    box = (
      <>
        <div className="drawing">
          {at && <img src={at.url} alt="Measuring drawing" />}
        </div>
        <div className="row">
          <span className="help">{at?.name}</span>
          <div className="row">
            {add("Replace")}
            <s-button onClick={() => put(undefined)}>Remove</s-button>
          </div>
        </div>
      </>
    );
  else
    box = (
      <div className="drop">
        <strong>Add a measuring drawing</strong>
        <span className="help">
          PNG or JPG. Number its lines to match the steps.
        </span>
        {add("Add image")}
      </div>
    );
  return {
    sending,
    reset: () => {
      sentOver.current = null;
      setView(null);
    },
    box: (
      <>
        <input
          ref={input}
          type="file"
          accept=".png,.jpg,.jpeg,image/png,image/jpeg"
          hidden
          aria-label="Measuring drawing file"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {box}
      </>
    ),
  };
}

export function MeasureTab(props: {
  draft: model.Draft;
  drawing: ReactNode;
  onChange: (d: model.Draft) => void;
}) {
  const { draft, onChange } = props;
  const steps = draft.content.measure.steps;
  const words = draft.content.words;
  const add = (primary = false) => (
    <s-button
      variant={primary ? "primary" : undefined}
      disabled={steps.length >= model.MAX_STEPS}
      onClick={() => {
        const next = model.addStep(draft);
        onChange(next);
        const id = next.content.measure.steps.at(-1);
        setTimeout(() => document.getElementById(`m-${id}-name`)?.focus());
      }}
    >
      Add step
    </s-button>
  );
  const word = (key: string) => ({
    value: words[key] ?? "",
    onChange: (e: { target: { value: string } }) =>
      onChange(model.setWord(draft, key, e.target.value)),
  });
  return (
    <div className="measure">
      <div className="col">
        <strong>Drawing</strong>
        {props.drawing}
      </div>
      <div className="col wide">
        <strong>Steps</strong>
        {steps.length ? (
          <>
            {steps.map((s, i) => (
              <div key={s} className="step">
                <span className="n" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="col">
                  <input
                    id={`m-${s}-name`}
                    className="field"
                    aria-label={`Step ${i + 1} name`}
                    maxLength={500}
                    {...word(`m.${s}.name`)}
                  />
                  <textarea
                    id={`m-${s}-text`}
                    className="field"
                    rows={3}
                    aria-label={`Step ${i + 1}, how to measure`}
                    maxLength={500}
                    {...word(`m.${s}.text`)}
                  />
                </div>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Remove step ${i + 1}`}
                  onClick={() => onChange(model.removeStep(draft, s))}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      d="M6 6l12 12M18 6 6 18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            ))}
            <div className="row start">
              {add()}
              <span className="help">
                Step 1 is line 1 on the drawing. Up to 20 steps.
              </span>
            </div>
          </>
        ) : (
          <div className="drop">
            <strong>No steps yet</strong>
            <span className="help">
              Tell shoppers where to hold the tape, one step per measurement.
            </span>
            {add(true)}
          </div>
        )}
      </div>
    </div>
  );
}
