# Trayvi — Provisional Brand Direction

> **Status: PROVISIONAL**

**Reference version:** 1  
**Recorded:** 2026-09-04  
**Authority:** Official provisional direction; not a production-ready brand system.

## 1. Brand concept

Trayvi is one platform for moving, requesting, and sending. Its visual identity should express mobility, geographic connection, clear direction, local usefulness, and forward momentum without making the product feel limited to one town or country.

Provisional marketing line:

> **Muévete. Pide. Envía.**

The line is presentation content. It must not be hardcoded in domain logic, used as an identifier, or treated as a permanent functional dependency.

## 2. Logo concept

The supplied symbol combines:

- the letter **T**, communicating trust and structure;
- the letter **V**, communicating direction and forward movement;
- a location pin, communicating local and on-demand service;
- a route/path, communicating movement and connection;
- a small orange point, acting as a destination or attention accent.

Together, these forms are intended to communicate mobility, location, connection, direction, movement, and on-demand services. The symbol and horizontal wordmark remain the official provisional concept.

The workspace now contains the original approved raster board, the retained v2.1 faithful trace, and a [v2.2 clean vector candidate](../../trayvi_brand_v2_2_clean/README.md). v2.2 replaces irregular traced edges with deliberate paths while preserving the approved wordmark and concept. It does not become the production master until the owner approves the visual comparison and legal/originality review is complete.

The raster board remains evidence rather than a production asset. Production delivery should originate from an approved SVG master, never an upscaled screenshot.

## 3. Visual personality

Trayvi should feel:

- modern, clean, and fast;
- friendly and trustworthy;
- technological without appearing cold;
- accessible and mobile-first;
- locally relevant without appearing small;
- capable of growing into a national or international brand.

Avoid a visual language that feels improvised, overly corporate, childish, saturated, or derivative of Uber, DiDi, PedidosYa, or another known platform. Familiar interaction patterns may support usability, but Trayvi must develop its own composition, iconography, motion, voice, and brand expression.

## 4. Provisional palette

| Color            | Value     | Intended role                                                                                       |
| ---------------- | --------- | --------------------------------------------------------------------------------------------------- |
| Primary Teal     | `#10BFA5` | Brand presence, primary emphasis, selection, active elements, and positive emphasis when accessible |
| Midnight Navy    | `#0B1623` | Headings, dark surfaces, navigation, high-hierarchy content, and brand contrast                     |
| White            | `#FFFFFF` | Primary surfaces, cards, contrast, and content on dark surfaces                                     |
| Orange Accent    | `#FF9F43` | Controlled food/promotion/attention accents and badges; never the global primary color              |
| Cloud Background | `#F7FAFC` | Main background and low-emphasis surface separation                                                 |
| Action Blue      | `#3478F6` | Routes, maps, selected secondary actions, and links only where contrast is sufficient               |
| Graphite         | `#182230` | Primary text, content, and neutral iconography                                                      |

Palette colors are not interchangeable with semantic meaning. Components consume semantic tokens documented in [Design Tokens](DESIGN_TOKENS.md). Brand teal and orange are not automatically valid text or status colors.

## 5. Interface direction

The current reference establishes:

- rounded cards and controls;
- clean surfaces and generous spacing;
- strong visual hierarchy;
- simple, coherent iconography;
- prominent primary calls to action;
- understandable navigation;
- maps as a central mobility surface;
- highly visible, redundant state feedback;
- modern sans-serif typography;
- mobile-first layouts.

The priority order is clarity, speed, perceived safety, accessibility, and consistency. Perceived safety must come from truthful states, useful identity and trip information, predictable controls, and recoverable errors—not decorative reassurance alone.

## 6. Maps and geographic meaning

The provisional mapping direction is:

- Action Blue `#3478F6` for route geometry;
- Primary Teal `#10BFA5` for origin, current selection, or a Trayvi driver where context makes the meaning unambiguous;
- Orange Accent `#FF9F43` for destination, attention, or selected promotional emphasis.

These associations are candidates, not immutable rules. Origin/destination/driver states require distinct shapes, labels, icons, and accessible descriptions so color is never the only differentiator. Provider map colors and light/dark modes must be tested before approval.

## 7. Product vision versus MVP

The concepts depict:

- travel by car;
- motorcycle rides;
- food;
- parcel/document delivery;
- stores;
- errands.

They describe Trayvi's broader product vision. They do not expand the mobility MVP or authorize delivery, commerce, or errands. A service is visible as operational only when its implementation phase has passed, operations are ready, its feature flag is enabled, and the active market supports it.

For example, the initial configuration may be conceptually equivalent to:

```text
market: villa-altagracia
rides_motorcycle: true
rides_car: false
food_delivery: false
stores: false
errands: false
parcel_delivery: false
```

These values are illustrative, not approved seed data. The real values belong to market configuration and must not be encoded in global design tokens or components.

## 8. Shared identity across future applications

The following future surfaces share foundations, brand, tokens, accessibility, and interaction principles:

- **Trayvi Customer** for consumers;
- **Trayvi Driver** for drivers and couriers;
- **Trayvi Business** for merchants;
- **Trayvi Admin** for internal operations.

They may use different information density, navigation, workflows, and safeguards. In particular, the Admin surface prioritizes precision, auditability, and least privilege; it must not inherit consumer patterns that obscure sensitive actions.

## 9. Provisional rules

- Use semantic tokens at component boundaries; do not scatter literal hex values.
- Do not use orange as the global primary action color.
- Do not use color as the sole state, service, route, or error cue.
- Do not present conceptual features as implemented.
- Do not embed Villa Altagracia in global branding.
- Do not derive production artwork from the supplied raster mockups.
- Do not assume the concept font, iconography, spacing, radii, shadows, or motion values are approved.
- Validate light/dark surfaces, pressed/focus/disabled/error states, text scaling, screen readers, reduced motion, and touch targets before releasing any component.

## 10. Accessibility observations

Initial WCAG contrast calculations show important constraints:

| Combination          | Contrast | Provisional conclusion                                                                                  |
| -------------------- | -------: | ------------------------------------------------------------------------------------------------------- |
| Teal on White        |   2.33:1 | Fails WCAG AA for normal and large text; do not use as text-only communication                          |
| Navy on White        |  18.21:1 | Passes normal text contrast                                                                             |
| Graphite on White    |  16.03:1 | Passes normal text contrast                                                                             |
| Action Blue on White |   4.07:1 | Fails AA normal text; may pass large text/non-text depending on use, but needs a darker text/link token |
| Orange on White      |   2.04:1 | Fails text contrast; use as decoration/background with a tested dark foreground                         |
| Navy on Teal         |   7.82:1 | Passes normal text contrast                                                                             |
| Navy on Orange       |   8.92:1 | Passes normal text contrast                                                                             |

These ratios use WCAG relative luminance and do not constitute complete accessibility approval. Final components must be tested in all states and contexts. Accessible status colors and darker interactive variants remain open design work.

## 11. Required before production

### Logo system

- original SVG/source artwork;
- horizontal, vertical/icon, and monochrome variants;
- variants for light and dark backgrounds;
- favicon and app-icon exports;
- clear-space and minimum-size rules;
- small-size legibility and optical correction;
- ownership, originality, and trademark review.

### Typography

- primary family and optional secondary family;
- weights, styles, scale, line height, and fallback stacks;
- mobile rendering and language coverage;
- web/app embedding and commercial license verification.

### Icons and illustration

- licensed icon source or original system;
- stroke/fill, grid, sizing, optical alignment, and state rules;
- map marker and service-category accessibility rules.

### Design system

- spacing, radius, elevation, breakpoints, and layout grids;
- typography, buttons, forms, cards, navigation, dialogs, feedback, and loading/empty/error states;
- light/dark/high-contrast behavior where supported;
- motion durations/easing and reduced-motion alternative;
- accessibility specifications and test matrix;
- component ownership, versioning, deprecation, and release process.

## 12. Open design decisions

- Compare and approve or reject the v2.2 cleaned geometry, then designate the official SVG masters.
- Select and license typography.
- Complete trademark/originality review for name and mark.
- Define spacing, radius, elevation, iconography, motion, and responsive scales.
- Define accessible semantic colors for links, focus, success, warning, error, and information.
- Decide whether and how “coming soon” services are ever shown.
- Define voice, tone, localization, imagery, illustration, and photography guidance.
- Validate app-icon recognition and logo legibility at small sizes.
- Test map semantics against actual map-provider styles and color-vision deficiencies.
