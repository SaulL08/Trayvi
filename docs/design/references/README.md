# Visual Reference Register

**Status:** PROVISIONAL — clean vector candidate available; original board and product UI source currently absent

The user supplied two visual concepts in conversation: a brand/logo presentation and a multi-screen product UI presentation. A brand source and vectorized v2.1 package were inspected previously but are no longer present in the workspace. A cleaned v2.2 candidate preserves the concept while replacing rough traced geometry. The original brand board and product UI presentation are not currently available as physical source files.

## Available brand material

| Artifact                                                                       | Reference content                                                       | SHA-256 / state                                                                                                 |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Approved brand board (previously inspected)                                    | Original approved raster concept and palette                            | File currently absent; last observed SHA-256 `4C00BD8B042CD7B0A882FF97F8D5347195940449B294C1AAAC38FB697F03354D` |
| v2.1 faithful package (previously inspected)                                   | Automatic/faithful vectorization used for comparison                    | No longer present in the workspace                                                                              |
| [v2.2 clean package](../../../trayvi_brand_v2_2_clean/README.md)               | Deliberately rebuilt clean vectors, PNG exports, tokens, and guidelines | Candidate pending owner approval                                                                                |
| [v2.2 preview](../../../trayvi_brand_v2_2_clean/trayvi-brand-v2-2-preview.png) | Presentation board for visual review                                    | `FE6E9EDA107487962C73FFB228E63EB21ADFD9DF33B93AE47108FB3731D153CF`                                              |

The v2.2 horizontal SVG master hash at creation is `FF4FA21A27C2F8C4C896AA818B45CE96DC4E67E2784CB73679F567C294C1D396`. If that file changes, regenerate exports, inspect them visually, and update this record rather than assuming PNGs remain current.

## Pending product UI reference

| Reserved filename                  | Reference content                                                                    | Current state                     |
| ---------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------- |
| `trayvi-product-ui-concept-v1.png` | Customer home, trip request, assigned-driver map, and food discovery concept screens | Awaiting original supplied binary |

When the product UI source is provided, retain source provenance/author/date/license information, record a SHA-256 checksum, and confirm that repository storage policy permits the file size. Do not substitute a screenshot generated from the chat display if the original file is available.

## Reference-only restrictions

- These files are design evidence, not application assets.
- They must not be imported from production source code or bundled into apps.
- Their visible services do not define MVP scope or market enablement.
- Their visible sample people, locations, prices, vehicles, plates, ratings, and merchant names are illustrative and must not become seed/production data without separate approval.
- Raster artwork must not be treated as the logo master; the v2.2 SVGs become masters only after owner approval.
- Rights, originality, trademark, font, photography, and icon licenses remain unverified.

See [Brand Direction](../BRAND_DIRECTION.md) for the interpreted design guidance and [Design Tokens](../DESIGN_TOKENS.md) for provisional values.
