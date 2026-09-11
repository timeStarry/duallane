# Theme foundation

The accepted theme, preview and preference rules are defined in
[the design system](../../../../../docs/design/ui-ux-rewrite/DESIGN_SYSTEM.md#5-主题架构).
This module is their production implementation; historical prototype values have
no independent authority and are never loaded by the application.

| Source | Ownership |
| --- | --- |
| [tokens.ts](tokens.ts) | The single production palette registry, semantic key type and supported theme IDs. |
| [preferences.ts](preferences.ts) | The versioned local preference contract, defaults, normalization and legacy mode migration. |
| [appearance.ts](appearance.ts) | System preference resolution and semantic CSS, material, motion, radius and density mappings. |
| [store.ts](store.ts) | Browser subscriptions, usable in-memory state and persistent-storage retry/error reporting. |
| [AppearanceProvider.tsx](AppearanceProvider.tsx) | React subscription through `AppearanceProvider` and `useAppearance()`. |

Initialize appearance before rendering. Existing names such as `--relay` and
`--panel` are aliases to the same semantic palette, never an old-skin fallback.
Component-specific geometry stays in the owning production CSS and follows the
design-system contract; it does not come from the prototype's JSON or CSS.

The registry currently supplies the five families specified in the design system,
including beige and minimal in both modes. `isThemeId` reads this registry for the
preference store and workbench. Theme `description` metadata is not rendered as
small print on preview cards. [ThemePicker](../../features/settings/ThemePicker.tsx)
renders its miniature product previews from the selected mode's actual palette;
it owns strip scrolling, drag-click suppression and focus visibility without
changing the conversation state.

## Changes and compatibility

Add a family to the registry and supported ID type, then run palette completeness,
contrast, preference fallback and component checks. Use the same semantic keys and
components; per-theme component branches and imported arbitrary CSS are outside
this contract. Version-1 preferences remain compatible when registered IDs grow.
The exact persisted defaults and migration decisions are executable in
`preferences.ts`; do not maintain a second table of defaults here.

The store publishes the independently resolved mode, density, motion and
transparency. System accessibility requirements are resolved before CSS is
applied. Consumers subscribe without using the appearance as a key that would
remount an editor. Storage failure affects persistence, not current usability.

From the repository root:

```powershell
corepack pnpm --filter @duallane/web exec vitest run src/ui/theme/theme.test.ts
node apps/web/src/features/settings/verify-appearance.mjs
node apps/web/src/ui/patterns/verify-message-surfaces.mjs
```

These checks use production palette data and synthetic component content.
Static contrast checks do not certify every transparent composition, browser or
assistive technology; broader evidence remains in the acceptance records.

The design data can support other renderers. Native clients still need their own platform components and accessibility behavior; the Web CSS and React components are not a native component library. No theme or platform adapter may combine P2P and Workspace data lifecycles.

See [the implemented architecture](../../../../../docs/design/ui-ux-rewrite/ARCHITECTURE.md) and [verification evidence](../../../../../docs/design/ui-ux-rewrite/PRODUCTION_VERIFICATION.md).
