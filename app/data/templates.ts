// Chart templates (ARCHITECTURE §5): columns, size rows, How to measure steps
// and words, never numbers. The merchant types every measurement.
import type { Column, Content, Template } from "../models/chart.server";

type Spec = {
  /** The template picker card (TemplatePicker board), word for word. */
  card: { name: string; measures: string; sizes: string; extra: string };
  size?: string;
  countries?: ("US" | "UK" | "EU" | "AU")[];
  measures?: [id: string, label: string][];
  text?: [id: string, label: string, cells: string[]];
  sizes?: string[];
  steps?: [name: string, text: string][];
  note?: string;
};

const ALL = ["US", "UK", "EU", "AU"] as const;
const LETTERS = ["XS", "S", "M", "L", "XL"];
const BUST: [string, string] = [
  "Bust",
  "Measure around the fullest part of your bust, keeping the tape level.",
];
const WAIST: [string, string] = [
  "Waist",
  "Measure around your natural waist, the narrowest part of your torso.",
];
const HIPS: [string, string] = [
  "Hips",
  "Stand with your feet together and measure around the fullest part of your hips.",
];

const SPECS: Record<Template, Spec> = {
  blank: {
    card: {
      name: "Blank chart",
      measures: "None yet: just a Size column",
      sizes: "Add your own",
      extra: "Nothing else, so it fits anything",
    },
  },
  tops: {
    card: {
      name: "Tops",
      measures: "Bust, waist, hips",
      sizes: "XS to XL",
      extra: "US, UK, EU, AU sizes; 3 how-to-measure steps",
    },
    countries: [...ALL],
    measures: [
      ["bust", "Bust"],
      ["waist", "Waist"],
      ["hips", "Hips"],
    ],
    sizes: LETTERS,
    steps: [BUST, WAIST, HIPS],
  },
  bottoms: {
    card: {
      name: "Bottoms",
      measures: "Waist, hips, inseam, rise",
      sizes: "XS to XL",
      extra: "US, UK, EU, AU sizes; 4 how-to-measure steps",
    },
    countries: [...ALL],
    measures: [
      ["waist", "Waist"],
      ["hips", "Hips"],
      ["inseam", "Inseam"],
      ["rise", "Rise"],
    ],
    sizes: LETTERS,
    steps: [
      WAIST,
      HIPS,
      [
        "Inseam",
        "Measure from the top of your inner thigh down to your ankle.",
      ],
      [
        "Rise",
        "On pants that fit you, measure from the crotch seam up to the top of the waistband.",
      ],
    ],
  },
  dresses: {
    card: {
      name: "Dresses",
      measures: "Bust, waist, hips, length",
      sizes: "XS to XL",
      extra: "US, UK, EU, AU sizes; 4 how-to-measure steps",
    },
    countries: [...ALL],
    measures: [
      ["bust", "Bust"],
      ["waist", "Waist"],
      ["hips", "Hips"],
      ["length", "Length"],
    ],
    sizes: LETTERS,
    steps: [
      BUST,
      WAIST,
      HIPS,
      [
        "Length",
        "Measure from the highest point of your shoulder down to where you want the hem.",
      ],
    ],
  },
  bras_swimwear: {
    card: {
      name: "Bras and swimwear",
      measures: "Underbust, bust",
      sizes: "Band and cup sizes",
      extra: "US, UK, EU band sizes; 2 how-to-measure steps",
    },
    countries: ["US", "UK", "EU"],
    measures: [
      ["under", "Underbust"],
      ["bust", "Bust"],
    ],
    sizes: ["32", "34", "36", "38"].flatMap((b) =>
      ["A", "B", "C", "D"].map((c) => b + c),
    ),
    steps: [
      [
        "Underbust",
        "Measure snugly around your ribcage, just under your bust, keeping the tape level.",
      ],
      BUST,
    ],
  },
  shoes: {
    card: {
      name: "Shoes",
      measures: "Foot length (in and cm)",
      sizes: "US sizes",
      extra: "UK and EU size columns; 1 how-to-measure step",
    },
    size: "US",
    countries: ["UK", "EU"],
    measures: [["foot", "Foot length"]],
    sizes: Array.from({ length: 15 }, (_, i) => `${5 + i / 2}`),
    steps: [
      [
        "Foot length",
        "Stand on a sheet of paper, mark your heel and your longest toe, and measure between the marks.",
      ],
    ],
  },
  kids: {
    card: {
      name: "Kids",
      measures: "Height, chest, waist",
      sizes: "By age",
      extra: "2 how-to-measure steps; a note on growing room",
    },
    size: "Age",
    measures: [
      ["height", "Height"],
      ["chest", "Chest"],
      ["waist", "Waist"],
    ],
    sizes: ["2", "3", "4", "5", "6", "7", "8", "10", "12", "14"].map(
      (a) => `${a} years`,
    ),
    steps: [
      [
        "Height",
        "Stand your child straight against a wall without shoes, and measure from the floor to the top of their head.",
      ],
      [
        "Chest and waist",
        "Measure around the fullest part of the chest, then around the natural waist.",
      ],
    ],
    note: "Between sizes? Pick the larger one, so there's room to grow.",
  },
  headwear: {
    card: {
      name: "Headwear",
      measures: "Head circumference",
      sizes: "S to XL",
      extra: "1 how-to-measure step",
    },
    measures: [["head", "Head circumference"]],
    sizes: ["S", "M", "L", "XL"],
    steps: [
      [
        "Head",
        "Measure around your head just above your ears and eyebrows, where the hat will sit.",
      ],
    ],
  },
  rings: {
    card: {
      name: "Rings",
      measures: "Inside diameter, circumference",
      sizes: "US ring sizes",
      extra: "UK and EU size columns; how to measure with string",
    },
    size: "US",
    countries: ["UK", "EU"],
    measures: [
      ["diam", "Inside diameter"],
      ["circ", "Circumference"],
    ],
    sizes: Array.from({ length: 11 }, (_, i) => `${3 + i}`),
    steps: [
      [
        "With string",
        "Wrap a piece of string around the base of your finger, mark where it meets, and measure the string flat against a ruler.",
      ],
    ],
  },
  bracelets: {
    card: {
      name: "Bracelets",
      measures: "Wrist, bracelet length",
      sizes: "S to L",
      extra: "1 how-to-measure step; a note on fit room",
    },
    measures: [
      ["wrist", "Wrist"],
      ["length", "Bracelet length"],
    ],
    sizes: ["S", "M", "L"],
    steps: [
      [
        "Wrist",
        "Wrap a soft tape measure around your wrist just above the wrist bone.",
      ],
    ],
    note: "Pick a bracelet a little longer than your wrist, so it moves freely.",
  },
  necklaces: {
    card: {
      name: "Necklaces",
      measures: "Chain length",
      sizes: "By length",
      extra: "Where each length sits on the body",
    },
    size: "Length",
    measures: [["chain", "Chain length"]],
    text: [
      "sits",
      "Where it sits",
      [
        "High around the neck",
        "At the base of the neck",
        "Just below the collarbone",
        "Above the bust",
        "At or below the bust",
        "Below the bust, or doubled",
      ],
    ],
    sizes: ["Collar", "Choker", "Princess", "Matinee", "Opera", "Rope"],
  },
};

export const TEMPLATE_IDS = Object.keys(SPECS) as Template[];
export const templateCard = (t: Template) => SPECS[t].card;

/** A new chart's content from template `t`: one table, no numbers. */
export function templateContent(t: Template): Content {
  const s = SPECS[t];
  const sizes = s.sizes ?? [];
  const columns: Column[] = [
    { id: "size", kind: "size" },
    ...(s.countries ?? []).map((country) => ({
      id: country.toLowerCase(),
      kind: "country" as const,
      country,
    })),
    ...(s.measures ?? []).map(([id]) => ({
      id,
      kind: "measure" as const,
      convert: true,
    })),
    ...(s.text ? [{ id: s.text[0], kind: "text" as const }] : []),
  ];
  const words: Record<string, string> = { "t1.size": s.size ?? "Size" };
  for (const c of s.countries ?? []) words[`t1.${c.toLowerCase()}`] = c;
  for (const [id, label] of s.measures ?? []) words[`t1.${id}`] = label;
  if (s.text) words[`t1.${s.text[0]}`] = s.text[1];
  sizes.forEach((size, i) => {
    words[`t1.r${i + 1}.size`] = size;
    if (s.text) words[`t1.r${i + 1}.${s.text[0]}`] = s.text[2][i];
  });
  if (s.note) words["t1.note"] = s.note;
  const steps = (s.steps ?? []).map(([name, text], i) => {
    words[`m.m${i + 1}.name`] = name;
    words[`m.m${i + 1}.text`] = text;
    return `m${i + 1}`;
  });
  return {
    v: 1,
    unit: "in",
    roundTo: 0.5,
    tables: [
      {
        id: "t1",
        columns,
        rows: sizes.map((_, i) => ({ id: `r${i + 1}`, cells: {} })),
      },
    ],
    measure: { steps },
    words,
  };
}
