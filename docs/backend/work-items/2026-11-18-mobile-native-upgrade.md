# Mobile native runtime upgrade policy

## Behavior and ownership

The Go Workspace service publishes two independent native-version boundaries:

- `release.ota.minNativeVersionCode` says which APK hosts can load a given Web bundle.
- `release.minimumSupportedNativeVersionCode` says which APK hosts may continue
  normal application use. Zero disables mandatory native updates.

`release.version` remains the interface/release version; `release.apkVersion` and
`release.versionCode` identify the hosted native APK. A standalone OTA preserves
the APK identity. Metadata cannot raise the APK version code without a new APK,
and the mandatory minimum cannot exceed the hosted APK's code or stay active
when distribution is disabled. Uploads preserve an existing mandatory minimum.
New APK uploads reject missing/ambiguous packaged identity and overrides that
disagree with it before writing a blob. The signed-package CI still verifies
this packaged identity against the real Android manifest and certificate; the
HTTP APK ZIP/config inspector is not a cryptographic signature verifier.
These additive JSON fields use existing preference persistence; no SQL migration
or new content store is introduced. The SDK admission policy remains independent.

## Compatibility and staged rollout

1. Publish and verify the signed APK and a compatibility OTA while the mandatory
   minimum remains zero. Existing native 10051+ hosts can use the current HTTP
   header bridge without installing a new native API first.
2. Verify the real old host receiving the compatibility OTA, the required-update
   page, public download/install recovery and the current native host.
3. Set the reviewed native minimum explicitly, selecting one rollout option:
   - Compatibility phase: 10054 (native 1.0.13), while compatibility OTA may still
     allow 10051. Undeclared legacy native background connections remain admitted.
   - Full native migration: 10100 (native 1.1.0) or later. This is the first APK
     line where native JSON/binary HTTP and background WS always declare their
     code. The service then rejects authenticated human Bearer business requests
     without a declaration as well as declarations below the supported floor.
     All older APKs must install a compatible package; cookie-based Web clients
     are not classified as native sessions.
4. Monitor failed updates before increasing the minimum again. Explicit zero
   disables mandatory update; retain a verified APK download throughout.

The public `/api/v1/mobile/native-policy` endpoint also returns a zero policy
when distribution has been withdrawn. It permits a client retaining an old
mandatory policy to recover without deleting its profile or credentials.

## Trust and enforcement

The compatibility OTA overwrites the public `X-DualLane-Native-Version-Code`
declaration with the immutable native snapshot's actual packaged version code.
The new native host also supplies this declaration on same-origin JSON/binary
HTTP and Workspace WebSocket handshakes. External origins and P2P envelopes do
not receive native metadata. The declaration is not identity, authorization,
attestation or proof against a hostile modified client.

For declared native business requests, Workspace enabled-gating and current
authentication run before the native compatibility check. Unsupported or invalid
declarations receive content-free HTTP426 `mobile.native_upgrade_required` with
the minimum, latest APK code and fixed public update locations. No request
content, supplied raw version, token or object existence enters that response.
Existing actor, object, quota, audit and idempotency checks remain in force.
Health, public downloads/update metadata, authentication and session recovery
routes remain reachable. Bot SDK transports use their separate SDK gate.

**Compatibility-phase background-socket limit:** old native hosts hardcode their singleton
Workspace socket URL and discard a JS-supplied path/query. The compatibility OTA
therefore enforces the full-screen client gate and HTTP declaration. When the
configured minimum is below `FirstNativeDeclarationVersionCode=10100`, undeclared
old native background connections remain admitted: that phase is deliberately
not a claim of complete server enforcement against every pre-existing APK.
At/above 10100, authenticated human Bearer connections must declare their code;
missing, invalid and obsolete declarations are rejected after authentication.
This threshold is a native transport capability baseline, not an SDK version or
an inferred OS/version-name comparison. No additional persisted switch is needed.
New native hosts pause automatic reconnect on
HTTP426, keep credentials and recheck policy when the application resumes.

Dynamic policy changes apply to subsequent business HTTP requests and new WS
handshakes. They do not revalidate or immediately close a WS that was already
established under the previous floor. Activation verification must include an
old host's reconnect after the new floor is set; it must not claim that raising
the floor instantaneously disconnects every existing background socket. Client
foreground checks still show the mandatory update screen, and business HTTP
requests are checked against the current floor independently of that old socket.

## Client safety and verification

The client compares the mandatory floor and APK upgrades against the true native
code/version, while OTA decisions compare interface version and bundle identity.
Known policies are cached per service origin, so network failure does not remove
an already-required update. Missing or malformed native codes cannot satisfy a
positive minimum. A blocked client exposes update/retry/install-permission
recovery, without close/back/skip-to-chat actions; Android installation remains
user-confirmed. Profiles, credentials, policies and drafts are not reset.

OTA downloads may stage in parallel, but automatic activation waits until there
are no pending writes, uploads, stored conversation/P2P drafts or focused nonempty
input. Activity tracks only counters and draft presence, never message content.
The existing bounded ZIP, digest, same-origin download and startup rollback
checks remain unchanged. Local failure, same-version drift, old-host/new-OTA,
APK visibility, cold/resume gate, policy withdrawal and update allowlist have
focused regression coverage. Actual native build/device and Go/PG evidence is
recorded with the release PR; no unrun check is implied here.
