# Data and security model

## What can leave a Mac

Sharing is selected per project, per account, on each Mac. Newly added projects start with all categories unchecked. Disabling a category stops its future indexing/uploads and automatic local application; it does not delete content already shared with other members or the server.

Memories, skills, plans, and sessions can contain private information. Session snapshots preserve complete conversations, including tool input/output and secrets that may have appeared in a conversation. Project scoping is not a secret-redaction guarantee. Review what you share and whom you invite.

Ordinary resources are authenticated and transported over HTTPS, but are not end-to-end encrypted by Orka. A self-hosting operator with database/blob access can access their contents. Server backups must be protected accordingly.

Governed projects enforce Hidden, Read, Suggest and Publish access in the shared
backend, with separate sharing management. Native memory remains personal;
discovery creates private candidates until explicitly submitted. Approved skills
and instructions require local installation review. Existing projects retain
their previous behavior until owner activation. See [permissions and memory](governed-sharing.md).

Permission changes refresh authorized local state, remove managed context and
preserve dirty work privately. They cannot erase prior downloads or conversations.
Orka-produced derivatives retain known source restrictions; this is not general
secret detection or control over arbitrary copies made outside Orka.

## Environment-variable sets

ENV sharing is a separate manual workflow. Enabling the category does not scan dotenv files or publish anything automatically. A user imports or pastes values, reviews keys and recipients, and explicitly publishes an encrypted set. Devices exchange approval codes through a trusted channel before receiving decryption access.

The server receives ciphertext and access metadata. Native encryption uses age, signed manifests, and device-specific keys. Access metadata is visible to the service. Removing access cannot erase values or keys a recipient previously obtained. This describes the implementation; it is not a claim of an independent cryptographic audit.

Pulling a set creates a temporary draft. Applying values is a separate operation with a preview, restricted to an untracked, ignored dotenv file inside the connected project. ENV data is excluded from ordinary resource exports and background sync.

## Trust boundaries

- Desktop session credentials live in macOS Keychain. Account caches and native project content remain sensitive local data.
- The API validates authentication, membership and governed resource access,
  including blob references, history, receipts and request attachments.
  Authentication administration stays inside the operator's private environment.
- Shared skills can contain executable scripts. Inspect them before enabling or running them through a coding tool.
- ZIP imports and native history are untrusted inputs. Path, size, hash, symlink, and framing checks protect their respective boundaries.
- Unknown session formats are preserved and visibly blocked rather than being rewritten speculatively.

## Development and reporting

Tests must use generated identities and synthetic conversations. Do not copy native home directories, Keychain exports, real ENV values, live databases, or production backups into fixtures. Use the isolated test harnesses described in [CONTRIBUTING.md](../CONTRIBUTING.md).

See [SECURITY.md](../SECURITY.md) for private reporting and credential-exposure handling.

## Retained local data

Chat, Activity, and AI account connections have been removed. This removal does
not erase existing SQLite history, recorded usage, or previously stored Keychain
entries. Orka no longer reads or refreshes those AI account credentials. Native
Claude Code and Codex authentication and project resource syncing are unchanged.
