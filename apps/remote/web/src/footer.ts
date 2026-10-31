// SPDX-License-Identifier: Apache-2.0
// The one UniverLab footer the remote paints: the sign-in, pair and hosts
// screens, the sessions home (both tabs), the session view, the graph and
// SysInfo views, and every guest screen. One shared constant so the
// colophon stays byte-identical everywhere; the colophon itself lives in
// packages/look and is never restyled here.
import { renderColophon } from "../../../../packages/look/colophon/footer.js";

export const REMOTE_FOOTER = renderColophon({
  product: "Canopy remote",
  exp: "EXP-001",
  links: [
    { label: "Canopy", href: "https://univerlab.org/canopy/" },
    { label: "univerlab.org", href: "https://univerlab.org/" },
    { label: "Source", href: "https://github.com/UniverLab/canopy-web" },
  ],
});
