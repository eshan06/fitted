// The Editor board's How to measure tab: the drawing (add, uploading,
// uploaded with Replace and Remove, not a PNG or JPG, didn't upload) and the
// numbered steps. The file is checked here and again by the route's action,
// then goes to Shopify Files; the chart holds it once the editor saves. An
// upload let go before a save (Replace, Remove, Discard, leaving the editor)
// is deleted from Files again; one left in a closed tab stays there.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFetcher, useFormAction, useSubmit } from "react-router";
import { IMAGE_MAX, imageType } from "../../lib/image-file";
import * as model from "./model";

type Answer = {
  image?: { id: string; url: string; sig: string };
  fieldErrors?: { measureImage?: string };
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
  const uploader = useFetcher<Answer>();
  const submit = useSubmit();
  // This route's, even when the discard is sent on the way out of it.
  const action = useFormAction();
  const input = useRef<HTMLInputElement>(null);
  // The answer on hand when the file was sent, so only a newer one counts;
  // null once nothing is awaited. `drop`: let go before it answered.
  const sentOver = useRef<{ answer?: Answer; drop?: true } | null>(null);
  // This visit's uploads that no save has sent yet, by id: their upload's sig.
  const unsaved = useRef(new Map<string, string>());
  const discard = (id: string, sig = unsaved.current.get(id)) => {
    unsaved.current.delete(id);
    // Best effort: a failure is logged and leaves the file in Files.
    if (sig)
      submit(
        { id, sig },
        {
          action,
          method: "delete",
          navigate: false,
          fetcherKey: `discard-${id}`,
        },
      );
  };
  const swap = (id: string | undefined) => {
    if (image && image !== id) discard(image);
    put(id);
  };
  // This render's handlers, for the effects below, which outlast it.
  const now = useRef({ discard, swap });
  now.current = { discard, swap };
  useEffect(() => {
    const left = unsaved.current;
    return () => left.forEach((_, id) => now.current.discard(id));
  }, []);
  const [view, setView] = useState<"type" | "failed" | null>(null);
  const [file, setFile] = useState<File>();
  const sending =
    uploader.state !== "idle" && !!sentOver.current && !sentOver.current.drop;

  useEffect(() => {
    const a = uploader.data;
    const old = sentOver.current;
    if (uploader.state !== "idle" || !old || !a || a === old.answer || !file)
      return;
    sentOver.current = null;
    if (old.drop) {
      if (a.image) now.current.discard(a.image.id, a.image.sig);
    } else if (a.image) {
      shown.set(a.image.id, { url: a.image.url, name: file.name });
      unsaved.current.set(a.image.id, a.image.sig);
      now.current.swap(a.image.id);
    } else setView(a.fieldErrors?.measureImage ? "type" : "failed");
  }, [uploader.state, uploader.data, file]);

  // ponytail: an image over 20 MB shows "didn't upload" until its own state is drawn.
  const pick = async (f?: File) => {
    // One upload at a time: a second would leave the first in Files.
    if (!f || sending) return;
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
  const open = () => input.current?.click();
  const add = (label: string) => <s-button onClick={open}>{label}</s-button>;
  const alert = (title: string, line: string, action: ReactNode) => (
    <div role="alert" className="drop bad">
      <s-icon type="alert-circle" tone="critical" />
      <strong>{title}</strong>
      <span>{line}</span>
      {action}
    </div>
  );
  const at = !image
    ? undefined
    : (shown.get(image) ??
      (storedUrl ? { url: storedUrl, name: nameOf(storedUrl) } : undefined));
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
      add("Try again"),
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
            <s-button onClick={() => swap(undefined)}>Remove</s-button>
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
    /** Discard: back to the stored drawing, letting go of this visit's uploads. */
    reset: () => {
      if (sentOver.current) sentOver.current.drop = true;
      unsaved.current.forEach((_, id) => discard(id));
      setView(null);
    },
    /** A save sends this drawing, so it's the chart's from now on. */
    keep: (id?: string) => id && unsaved.current.delete(id),
    open,
    box,
    // Kept mounted outside the tab, so the box under the size table can open it.
    input: (
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
