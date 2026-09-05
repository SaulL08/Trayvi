# Trayvi — Provisional Design Tokens

> **Status: PROVISIONAL**

This document defines naming and current mappings, not a production token package. Values can change after accessibility, brand, device, and map testing. Applications must consume semantic tokens instead of literal palette names wherever meaning is involved.

## 1. Naming model

Tokens use dot-separated hierarchical names:

```text
color.<category>.<role>[.<state>]
```

- **Reference/palette tokens** describe a raw visual value.
- **Semantic tokens** describe intent and are the only tokens normal components should consume.
- **Component tokens**, introduced later only when needed, map a specific component part/state to semantic tokens.

Do not name component behavior after colors such as `tealButton` or `orangeText`. Do not place raw hexadecimal values throughout application code.

## 2. Reference palette

| Token                        | Value     | Description                                  |
| ---------------------------- | --------- | -------------------------------------------- |
| `color.palette.trayviTeal`   | `#10BFA5` | Primary provisional brand color              |
| `color.palette.midnightNavy` | `#0B1623` | Dark brand and high-contrast surface         |
| `color.palette.white`        | `#FFFFFF` | Light surface and inverse content            |
| `color.palette.orangeAccent` | `#FF9F43` | Controlled attention/category accent         |
| `color.palette.cloud`        | `#F7FAFC` | Main light background                        |
| `color.palette.actionBlue`   | `#3478F6` | Route and provisional secondary-action color |
| `color.palette.graphite`     | `#182230` | Primary neutral content color                |

Reference token names are provisional implementation details. Product components must not infer state meaning from them.

## 3. Required semantic mappings

| Semantic token                      | Current mapping | Intended use                                        |
| ----------------------------------- | --------------- | --------------------------------------------------- |
| `color.brand.primary`               | `#10BFA5`       | Global brand expression and emphasis                |
| `color.brand.secondary`             | `#0B1623`       | Dark brand expression                               |
| `color.background.primary`          | `#F7FAFC`       | Default application background                      |
| `color.background.inverse`          | `#0B1623`       | Dark/inverse background                             |
| `color.surface.primary`             | `#FFFFFF`       | Cards, sheets, and primary surfaces                 |
| `color.surface.inverse`             | `#0B1623`       | Dark cards/navigation surfaces                      |
| `color.accent.orange`               | `#FF9F43`       | Controlled category, promotion, or attention accent |
| `color.action.primary.background`   | `#10BFA5`       | Primary action background                           |
| `color.action.primary.foreground`   | `#0B1623`       | Accessible content on primary action background     |
| `color.action.secondary.background` | `#0B1623`       | Secondary/dark action background                    |
| `color.action.secondary.foreground` | `#FFFFFF`       | Content on secondary/dark action background         |
| `color.route.primary`               | `#3478F6`       | Primary route line on compatible maps               |
| `color.text.primary`                | `#182230`       | Primary text on light surfaces                      |
| `color.text.inverse`                | `#FFFFFF`       | Text on Midnight Navy                               |

This satisfies the minimum provisional mappings:

```text
brand.primary       #10BFA5
brand.secondary     #0B1623
background.primary  #F7FAFC
surface.primary     #FFFFFF
accent.orange       #FF9F43
action.blue         #3478F6
text.primary        #182230
```

`action.blue` is retained as a reference alias for the supplied direction, but new component APIs should prefer a semantic role such as `color.route.primary` or a future accessible link token.

## 4. Provisional state and map tokens

These mappings require component-level accessibility validation:

| Semantic token                    | Provisional mapping | Constraint                                                 |
| --------------------------------- | ------------------- | ---------------------------------------------------------- |
| `color.location.origin`           | `#10BFA5`           | Pair with origin icon/label/shape                          |
| `color.location.destination`      | `#FF9F43`           | Pair with destination icon/label/shape                     |
| `color.location.route`            | `#3478F6`           | Validate against each map style and line width             |
| `color.status.success.background` | `#10BFA5`           | Use dark foreground and a non-color cue                    |
| `color.status.warning.background` | `#FF9F43`           | Use dark foreground and a non-color cue                    |
| `color.status.error`              | **TBD**             | A compliant error scale has not been selected              |
| `color.status.info`               | **TBD**             | A compliant informational scale has not been selected      |
| `color.focus.ring`                | **TBD**             | Must contrast against adjacent light and dark colors       |
| `color.link.default`              | **TBD**             | `#3478F6` is only 4.07:1 on white and fails AA normal text |

Teal, blue, and orange cannot communicate origin, route, destination, success, warning, or attention without an icon, text, pattern, or shape distinction.

## 5. Contrast baseline

WCAG relative-luminance calculations for current reference colors:

| Foreground/background pair |   Ratio | Text guidance                         |
| -------------------------- | ------: | ------------------------------------- |
| `#10BFA5` / `#FFFFFF`      |  2.33:1 | Not suitable for normal or large text |
| `#0B1623` / `#FFFFFF`      | 18.21:1 | Suitable for normal text              |
| `#182230` / `#FFFFFF`      | 16.03:1 | Suitable for normal text              |
| `#3478F6` / `#FFFFFF`      |  4.07:1 | Not suitable for WCAG AA normal text  |
| `#FF9F43` / `#FFFFFF`      |  2.04:1 | Not suitable for text                 |
| `#0B1623` / `#10BFA5`      |  7.82:1 | Suitable for normal text              |
| `#0B1623` / `#FF9F43`      |  8.92:1 | Suitable for normal text              |
| `#182230` / `#F7FAFC`      | 15.29:1 | Suitable for normal text              |

Ratios are a preliminary mathematical check, not component certification. Font size/weight, adjacent colors, focus states, opacity, overlays, disabled treatments, outdoor/mobile conditions, and non-text contrast still require testing.

## 6. Non-color foundations

The following namespaces are reserved conceptually but have no approved values yet:

```text
font.family.*
font.weight.*
font.size.*
font.lineHeight.*
space.*
radius.*
shadow.*
icon.size.*
motion.duration.*
motion.easing.*
layout.breakpoint.*
touchTarget.*
```

No engineer should invent a production scale under these namespaces without an approved design-system phase or scoped ADR/design decision.

## 7. Accessibility requirements for token implementation

- Test WCAG contrast for every foreground/background/state combination actually rendered.
- Preserve meaning without color and expose semantic labels to assistive technologies.
- Support platform text scaling without clipping or hidden actions.
- Define visible keyboard focus for web and appropriate focus order for all surfaces.
- Meet platform-appropriate touch target and spacing guidance.
- Provide pressed, focused, selected, disabled, loading, success, warning, and error states.
- Respect reduced-motion and contrast preferences where platform support exists.
- Test maps, markers, and routes for color-vision deficiency and multiple provider styles.

## 8. Future delivery format

When the design system is implemented, one reviewed source of truth should generate platform outputs for React Native and web, preserving names and documented transformations. Generated files must be reproducible and checked for drift. The token package must not import product/domain logic, market configuration, or service availability.

Version changes follow semantic impact:

- value adjustment with equivalent meaning: compatible token release;
- token rename/removal or semantic change: migration and deprecation plan;
- application-specific override: product-surface layer, not mutation of the global token.
