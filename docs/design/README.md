# Trayvi Design Documentation

**Status:** PROVISIONAL  
**Purpose:** Official provisional visual and product-design reference for Trayvi.

This directory records the visual direction supplied before Phase 0 implementation. It is documentation only: it does not authorize product screens, production assets, a component library, or any Customer, Driver, Business, or Admin functionality.

## Documents

- [Brand direction](BRAND_DIRECTION.md) defines the logo concept, personality, visual language, product-surface relationship, and limits of the reference material.
- [Design tokens](DESIGN_TOKENS.md) records the provisional palette and semantic token strategy, including current accessibility constraints.
- [Visual references register](references/README.md) tracks the supplied concepts and the source files still required.

## Authority and precedence

These documents are the official provisional design reference until a reviewed production brand system supersedes them. They guide presentation-layer decisions but do not change the backend architecture, domain invariants, security requirements, phase gates, or actual feature availability.

If a mockup conflicts with implemented product state, authorization, market configuration, accessibility, security, privacy, or an audited phase decision, the verified system state and approved requirements take precedence. The discrepancy must be resolved in design; it must not be hidden by fake UI behavior.

## Anti-fake-product rule

A feature is presented as available only when all of the following are true:

- its backend capability and state model exist;
- authentication and authorization are enforced server-side;
- business rules, error handling, tests, and observability exist;
- the owning phase audit passed with no unresolved Critical or High findings;
- the relevant feature flag is enabled;
- the current market is configured and operationally ready for the service.

Disabled or unimplemented features remain hidden unless an explicit product decision defines a truthful, accessible “coming soon” treatment. Concept screens showing travel, motorcycle rides, food, parcel delivery, stores, and errands are a product vision—not proof of availability.

## Future design-system boundary

The intended shared system is organized conceptually as:

```text
Trayvi Design System
├── Foundations
│   ├── Colors
│   ├── Typography
│   ├── Spacing
│   ├── Radius
│   ├── Shadows
│   ├── Icons
│   └── Motion
├── Components
├── Patterns
└── Product Surfaces
    ├── Customer
    ├── Driver
    ├── Business
    └── Admin
```

Foundations and accessible interaction principles are shared. Product surfaces may use different layouts and workflows appropriate to their users; they are not required to share every component.

No design-system code is created as part of this documentation update. A future implementation must use semantic tokens rather than binding components directly to palette names.

## Global and multi-market rule

Trayvi's brand, application names, global tokens, and shared components are market-independent. Villa Altagracia is the first configured market and is not part of the permanent logo, product name, or global visual system.
