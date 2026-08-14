# Workspace Design Index

## 1. Purpose

This index explains where each Workspace product or implementation question
belongs. It exists so the development loop can use the right document without
turning the full design set into one large, flat specification.

External product name: **共享空间 / 空间**

Internal engineering name: `Workspace`

## 2. Reading Order

Use this order when starting or reviewing Workspace work:

1. [Shared Space Workspace Product Design](WORKSPACE_PRODUCT_DESIGN.md)
2. [Workspace MVP Development Contract](WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md)
3. [Workspace UI Interaction Design](WORKSPACE_UI_INTERACTION_DESIGN.md)
4. [Workspace Screen And Component Specification](WORKSPACE_SCREEN_COMPONENT_SPEC.md)
5. [Workspace Visual System Design](WORKSPACE_VISUAL_SYSTEM_DESIGN.md)
6. [Workspace State And Feedback Design](WORKSPACE_STATE_FEEDBACK_DESIGN.md)
7. [Workspace Client Data And View Model Design](WORKSPACE_CLIENT_DATA_VIEW_MODEL.md)
8. [Workspace API Contract](WORKSPACE_API_CONTRACT.md)
9. [Workspace Data Model Design](WORKSPACE_DATA_MODEL_DESIGN.md)
10. [Workspace Productization Roadmap](WORKSPACE_PRODUCTIZATION_ROADMAP.md)
11. [Workspace Product Acceptance Matrix](WORKSPACE_PRODUCT_ACCEPTANCE_MATRIX.md)
12. The specific domain document for the feature being changed.

The system-level boundary remains in [DualLane Design Document](../DESIGN.md).

## 3. Document Ownership

| Document | Use for | Do not use for |
| --- | --- | --- |
| [WORKSPACE_PRODUCT_DESIGN.md](WORKSPACE_PRODUCT_DESIGN.md) | Product definition, tone, trust model, high-level scope | Endpoint-level implementation details |
| [WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md](WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md) | First full-loop required scope, API/data requirements, validation | Long-term product exploration |
| [WORKSPACE_UI_INTERACTION_DESIGN.md](WORKSPACE_UI_INTERACTION_DESIGN.md) | Component/window behavior, mobile/desktop interaction, complexity control | Database schema details |
| [WORKSPACE_SCREEN_COMPONENT_SPEC.md](WORKSPACE_SCREEN_COMPONENT_SPEC.md) | Concrete screen inventory, component requirements, and P0 UI acceptance | Database schema or transport protocol |
| [WORKSPACE_VISUAL_SYSTEM_DESIGN.md](WORKSPACE_VISUAL_SYSTEM_DESIGN.md) | Visual hierarchy, tokens, component patterns, density, icons, and anti-patterns | API semantics or database lifecycle |
| [WORKSPACE_STATE_FEEDBACK_DESIGN.md](WORKSPACE_STATE_FEEDBACK_DESIGN.md) | Loading, empty, error, quota, permission, reconnect, and confirmation behavior | Long-term product strategy |
| [WORKSPACE_CLIENT_DATA_VIEW_MODEL.md](WORKSPACE_CLIENT_DATA_VIEW_MODEL.md) | Client fetching, normalized view state, event projection, and refetch policy | Backend storage internals |
| [WORKSPACE_API_CONTRACT.md](WORKSPACE_API_CONTRACT.md) | HTTP/WebSocket endpoints, request/response shapes, capability flags, and error contract | Visual layout or copy tone |
| [WORKSPACE_DATA_MODEL_DESIGN.md](WORKSPACE_DATA_MODEL_DESIGN.md) | Persistent entities, state machines, indexes, retention, and data boundaries | Screen layout or component behavior |
| [WORKSPACE_AUTH_INVITE_DESIGN.md](WORKSPACE_AUTH_INVITE_DESIGN.md) | GitHub login, seeded owner, invite-only entry, invite creation/acceptance | Daily chat layout |
| [WORKSPACE_INFORMATION_ARCHITECTURE.md](WORKSPACE_INFORMATION_ARCHITECTURE.md) | Navigation hierarchy and layout model | Exact component state copy |
| [WORKSPACE_USER_FLOW_DESIGN.md](WORKSPACE_USER_FLOW_DESIGN.md) | Step-by-step user flows | Low-level schema fields |
| [WORKSPACE_IM_PRODUCT_DESIGN.md](WORKSPACE_IM_PRODUCT_DESIGN.md) | IM product surface, chat window, member/file/chat expectations | Storage implementation |
| [WORKSPACE_CONVERSATION_GROUP_DESIGN.md](WORKSPACE_CONVERSATION_GROUP_DESIGN.md) | Direct chats, group chats, group details and membership | Space-level invite policy |
| [WORKSPACE_MEMBER_PERMISSION_DESIGN.md](WORKSPACE_MEMBER_PERMISSION_DESIGN.md) | Members, roles, invites, permissioned surfaces | Message block protocol |
| [WORKSPACE_FILE_QUOTA_DESIGN.md](WORKSPACE_FILE_QUOTA_DESIGN.md) | Attachments, file library, upload/download quota | Conversation list design |
| [WORKSPACE_SPACE_SETTINGS_DESIGN.md](WORKSPACE_SPACE_SETTINGS_DESIGN.md) | Space information/settings, invites, roles, capacity/history settings | Public login or chat composer behavior |
| [WORKSPACE_SEARCH_DISCOVERY_DESIGN.md](WORKSPACE_SEARCH_DISCOVERY_DESIGN.md) | Search, filtering, and discovery for conversations, members, files, and later messages | Storage indexes as an implementation detail |
| [WORKSPACE_NOTIFICATION_UNREAD_DESIGN.md](WORKSPACE_NOTIFICATION_UNREAD_DESIGN.md) | Local notices, unread state, mentions, and notification preferences | Browser push implementation details |
| [WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md](WORKSPACE_MOBILE_ACCESSIBILITY_DESIGN.md) | Mobile pane model, responsive behavior, keyboard/focus/accessibility | Backend schema |
| [WORKSPACE_MESSAGE_PROTOCOL.md](WORKSPACE_MESSAGE_PROTOCOL.md) | Structured messages, blocks, idempotency, bot compatibility | Visual layout |
| [WORKSPACE_ECHO_BOT_DESIGN.md](WORKSPACE_ECHO_BOT_DESIGN.md) | Echo bot product behavior, reusable cards, commands, guided workflows, voting, and requirement processing | Core message transport or unrelated bot behavior |
| [WORKSPACE_AGENT_BOT_PLATFORM_REQUIREMENTS.md](WORKSPACE_AGENT_BOT_PLATFORM_REQUIREMENTS.md) | User Agent Bot Gateway, external runtime adapters, Feishu-compatible cards, secure commands, tokens, scopes, and API authorization | Echo-specific solicitation domain details |
| [WORKSPACE_GROUP_TOPIC_DESIGN.md](WORKSPACE_GROUP_TOPIC_DESIGN.md) | Group topic syntax, child message streams, topic cards, group sync projections, navigation, permissions, and Markdown image compatibility | General group membership or unrelated card domains |
| [WORKSPACE_REALTIME_EVENT_DESIGN.md](WORKSPACE_REALTIME_EVENT_DESIGN.md) | Event envelope, replay, projection, visibility filtering | Normal HTTP API payloads |
| [WORKSPACE_PRODUCTIZATION_ROADMAP.md](WORKSPACE_PRODUCTIZATION_ROADMAP.md) | P0/P1/P2 implementation order, gates, and productization acceptance | Detailed protocol or schema definitions |
| [WORKSPACE_PRODUCT_ACCEPTANCE_MATRIX.md](WORKSPACE_PRODUCT_ACCEPTANCE_MATRIX.md) | Persona, screen, backend, realtime, quota, disclosure, and manual release acceptance | New feature design exploration |
| [O2O_PRODUCT_DESIGN.md](O2O_PRODUCT_DESIGN.md) | Private direct lane product model and invite secrets | Workspace server-retained behavior |

## 4. Feature-To-Document Map

| Feature area | Primary document | Supporting documents |
| --- | --- | --- |
| Login and invite-only access | Auth Invite | User Flow, Member Permission, MVP Contract |
| Seeded owner and OAuth invite acceptance | Auth Invite | MVP Contract, User Flow |
| Seeded first owner | MVP Contract | Member Permission |
| Public login page | UI Interaction | User Flow, Information Architecture |
| Screen/component implementation | Screen Component Spec | UI Interaction, Information Architecture |
| Loading/empty/error feedback | State Feedback | UI Interaction, User Flow |
| Client data fetching/projection | Client Data View Model | Realtime Event, UI Interaction |
| Conversation list | Conversation Group | UI Interaction, IM Product |
| Direct chat creation | Conversation Group | User Flow, Member Permission |
| Group creation and settings | Conversation Group | UI Interaction, Information Architecture |
| Member directory | Member Permission | Client Data View Model, UI Interaction, IM Product |
| Structured message send/render | Message Protocol | IM Product, UI Interaction |
| Workspace HTTP/WebSocket APIs | API Contract | MVP Contract, Client Data View Model, Realtime Event |
| Workspace persistence schema | Data Model Design | MVP Contract, Message Protocol, File Quota |
| Reply/reaction/edit/delete roadmap | Message Protocol | IM Product |
| File upload/download | File Quota | User Flow, MVP Contract |
| Standalone files | File Quota | Information Architecture, UI Interaction |
| Quota and transfer ledger | File Quota | MVP Contract |
| Quota user feedback | State Feedback | File Quota, UI Interaction |
| Space information and settings | Space Settings | Member Permission, File Quota, UI Interaction |
| Operation records | MVP Contract | Product Design, Member Permission |
| Realtime events and reconnect | Realtime Event | Client Data View Model, UI Interaction, Message Protocol |
| Local notices and unread model | Notification Unread | Realtime Event, Client Data View Model, State Feedback |
| AI bot compatibility | Message Protocol | Realtime Event, Product Design |
| Echo bot and interactive cards | Echo Bot Design | Message Protocol, Realtime Event, Member Permission, API Contract |
| User Agent Bot and external runtime integration | Agent Bot Platform Requirements | Message Protocol, Realtime Event, Member Permission, API Contract, Auth Invite |
| Group topics and topic message sync | Group Topic Design | Message Protocol, Conversation Group, Realtime Event, Client Data View Model, UI Interaction |
| Search and discovery | Search Discovery | Client Data View Model, Conversation Group, File Quota |
| Mobile layout | UI Interaction | Information Architecture |
| Mobile accessibility and focus | Mobile Accessibility | Screen Component Spec, UI Interaction, State Feedback |
| Mobile sheets and screen transitions | Screen Component Spec | State Feedback |
| Visual hierarchy and component density | Visual System Design | UI Interaction, Screen Component Spec |
| Product copy and tone | Product Design | UI Interaction |
| Productization loop order and gates | Productization Roadmap | MVP Contract, Design Index |
| Productized release acceptance | Product Acceptance Matrix | Productization Roadmap, MVP Contract |

## 5. P0 Development Gates

Before a Workspace implementation slice is considered ready for the first
productized loop, check the slice against these gates:

- The public login page still shows only GitHub login.
- The feature is reachable from the correct product surface.
- Normal members do not see owner/admin controls unless the action is relevant
  and allowed.
- Backend permission checks remain authoritative.
- Rejected sensitive operations write database operation records.
- P2P message and file content are not persisted by Workspace services.
- Invite-link `#k=` fragments remain browser-only for private direct links.
- File upload and download quota is checked before transfer.
- Workspace remains disabled by default unless `WORKSPACE_ENABLED=true`.
- UI copy uses `共享空间` or `空间` for external surfaces.
- API responses use product-shaped objects and do not expose raw database rows
  or platform internals.
- Data model changes preserve explicit membership, attachment, quota, event,
  and operation-record boundaries.

## 6. Productization Gates

The Workspace UI should not pass review if it regresses to a flat page.

Required hierarchy:

- Lane choice before shared-space entry.
- GitHub-only public Workspace login.
- Conversation list/navigation rail.
- Active conversation surface.
- Context drawer or sheet for conversation details.
- Dedicated file library.
- Dedicated member directory.
- Space information and privileged settings.
- Screen-level acceptance follows
  [Workspace Screen And Component Specification](WORKSPACE_SCREEN_COMPONENT_SPEC.md).
- Loading, empty, error, permission, quota, and reconnect behavior follows
  [Workspace State And Feedback Design](WORKSPACE_STATE_FEEDBACK_DESIGN.md).
- Client-side data fetching, normalized view models, realtime projection, and
  targeted refetch policy follow
  [Workspace Client Data And View Model Design](WORKSPACE_CLIENT_DATA_VIEW_MODEL.md).
- Visual hierarchy, component density, icon use, and responsive polish follow
  [Workspace Visual System Design](WORKSPACE_VISUAL_SYSTEM_DESIGN.md).
- API and persistent data contracts follow
  [Workspace API Contract](WORKSPACE_API_CONTRACT.md) and
  [Workspace Data Model Design](WORKSPACE_DATA_MODEL_DESIGN.md).
- Persona, screen, backend, realtime, quota, disclosure, and manual acceptance
  follow
  [Workspace Product Acceptance Matrix](WORKSPACE_PRODUCT_ACCEPTANCE_MATRIX.md).

Required daily-use behavior:

- A regular member can chat without opening settings.
- A regular member can find files without locating the original message.
- A regular member can find another member and start a direct chat.
- A group member can inspect group members and group files.
- Owner/admin controls are discoverable but not always visible.
- Search and filtering stay scoped to conversations, members, files, or the
  current object instead of exposing one flat platform search.
- Local notices, unread cues, and future notification settings do not expose
  event sequences or operation records.

## 7. Deferred Topics

These are explicitly not required for the first full Workspace loop:

- AI bot execution.
- Full-text search.
- Message edit/delete UI.
- Reactions.
- Push notifications.
- Multi-space switching UI.
- Owner/admin operation-record review UI.
- File preview and text extraction.
- Advanced group posting policy.
- Encrypted shared-space rooms.

The current documents reserve protocol, event, and schema paths for these later
features, but they should not block P0.
