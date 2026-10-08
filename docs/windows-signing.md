# Windows Signing

Azure Artifact Signing is the proposed Windows signing provider. This workflow
does not acquire a certificate, create an Azure account, or establish the Open
Home Foundation's eligibility. A maintainer must approve the provider, complete
Microsoft's organization identity validation, and validate a protected signed
Windows build before distributing it. Geographic availability in Switzerland
does not establish approval of the Foundation.

## Protected Setup

1. Create an Artifact Signing account and a **Public Trust** certificate profile
   with the Foundation's verified identity. Record the profile's exact certificate
   subject, not just its display name.
2. Create an Entra application/service principal. Grant only the **Artifact
   Signing Certificate Profile Signer** role at the required certificate profile
   scope. No subscription-wide Contributor role or client secret is required.
3. Configure its GitHub federated credential with issuer
   `https://token.actions.githubusercontent.com`, audience
   `api://AzureADTokenExchange`, and exact subject
   `repo:home-assistant/installer:environment:release`. Do not trust fork, pull
   request, branch-wildcard, or other environment subjects.
4. Before merging this workflow, create the GitHub `release` environment and
   select a deployment branch rule for `main` only, with no tag rules. Protect
   `main` separately; allowing all protected branches is not equivalent.
   Store these **environment variables** there:

   | Variable | Value |
   |----------|-------|
   | `AZURE_CLIENT_ID` | Entra application's client ID |
   | `AZURE_TENANT_ID` | Entra tenant ID |
   | `WINDOWS_SIGNING_ENDPOINT` | Account's regional HTTPS endpoint, for example `https://swn.codesigning.azure.net` |
   | `WINDOWS_SIGNING_ACCOUNT` | Artifact Signing account name |
   | `WINDOWS_SIGNING_PROFILE` | Public Trust certificate profile name |
   | `WINDOWS_SIGNING_SUBJECT` | Exact verified certificate subject, including organization and country |

These are identifiers, not private keys. The private signing key stays with
Microsoft. Missing configuration fails the protected build; there is no unsigned
fallback. The future tag-release and nightly workflows must use this same signing
contract and arrange their own protected deployment policy. This change does not
enable tags or change GitHub/Azure settings.

The pre-created environment's main-only deployment policy is the security barrier,
not this workflow's condition. Another branch can change a workflow to select
`release` and obtain the same environment-based OIDC subject if the environment
allows it. Referencing an environment that does not exist can create it without
protection. Do not merge until the environment protection and exact federation
subject are both provisioned and verified by a maintainer.

## Signing Boundary

Pull request builds remain unsigned and never select `release` or perform Azure
login. Protected main builds compile without a Rust cache, then authenticate with
the pinned Azure login action using OIDC. GitHub's `id-token: write` permission is
job-wide: **the main build scripts and dependencies are inside the signing trust
boundary**, and could request an OIDC token even before the login step. Splitting
compilation and signing into separately permissioned jobs with an authenticated
artifact handoff would be required to isolate them. Step-local configuration is
not a sandbox against malicious main code or dependencies. Protect main and review
workflow and dependency changes accordingly.

The wrapper downloads fixed Microsoft SDK and Artifact Signing client NuGet
versions and verifies their committed SHA256 hashes before extraction. It uses
the Windows runner's Azure CLI, PowerShell 7 and .NET 8 runtime. The client allows
only the Azure CLI credential established by OIDC; environment, managed-identity,
developer-tool and interactive fallbacks are excluded. Azure login clears its
session in its post action; temporary signing files are removed on failure too.

Tauri's structured `signCommand` passes each path as a separate argument. The
command signs the application before each package, the NSIS uninstaller during
packaging, and each completed MSI/NSIS installer. Each invocation uses SHA256 and
Microsoft's RFC3161 timestamp service, then requires successful SignTool
Authenticode verification with a timestamp and the configured publisher subject.
Exactly one final MSI and one NSIS installer are independently verified again
before artifact upload; neither current format is removed. WiX extension/resource
signing also uses the same checked command. Tauri's default NSIS uninstaller
finalizer ignores its command's exit status. The additional supported installer
hook appends verification with an explicit `= 0` comparison, making signing or
verification failure fatal before embedding the uninstaller.
Tauri restores the original unsigned build binary after bundling, so verification
of the patched application must happen in the command, before either format embeds
it. Do not replace this with signing only the outer installer.

## Acceptance

The PowerShell guard tests use a mock signer and run on Windows PR builds. NSIS
compile-only fixtures check finalizer order and fatal signing/verification errors
on Linux and with Tauri's downloaded Windows compiler. They never execute an
installer and do not validate Azure authentication, real signatures, certificate
trust, or Windows installation. Before shipping, run the protected
workflow and inspect signatures on the application, installer, and installed
uninstaller on a clean supported Windows machine. Test MSI and NSIS independently.
Check the displayed Foundation publisher and timestamp, install/uninstall behavior,
MSI maintenance/repair, and a deliberately missing configuration failure. Record
the successful run and tested Windows version.

Signing does not promise immediate SmartScreen reputation or prevent antivirus
warnings. New signed beta downloads can still trigger a warning. Never tell users
that signing removes every Windows security warning.

## References

- [Microsoft account and identity prerequisites](https://learn.microsoft.com/azure/artifact-signing/quickstart)
- [Microsoft signing integrations and SignTool](https://learn.microsoft.com/azure/artifact-signing/how-to-signing-integrations)
- [Azure login with OIDC](https://github.com/Azure/login#login-with-openid-connect-oidc-recommended)
- [GitHub environment creation and protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [Tauri Windows signing](https://tauri.app/distribute/sign/windows/)
- [NSIS compile-time finalizers](https://nsis.sourceforge.io/Docs/Chapter5.html#uninstfinalize)
