// The size guide's own words (ARCHITECTURE §9), as the theme app extension's
// default locale has them, for the admin's live preview. Read on the server:
// in development the Shopify CLI serves /extensions/ to the browser itself.
import locale from "../../extensions/size-guide/locales/en.default.json";

export const guideWords: Record<string, string> = locale.size_guide;
