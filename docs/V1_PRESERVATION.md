# SHC v1 Preservation Record

Originally recorded on 2026-09-02 before removing the duplicated MongoDB source
archive from the v2 repository. The repository references and local history were
verified again on 2026-09-07 when carrying that cleanup into the consolidated
Supabase backend.

## Pinned source snapshots

- Backend v1: https://github.com/tsar-b/smart-homecare-backend-v1
  - branch: `master`
  - commit: `0908e068d2497b1f2bafc7764b2d56aa41407fab`
- Frontend v1: https://github.com/tsar-b/smart-homecare-frontend-v1
  - branch: `main`
  - commit: `98755283a4e0dec318cba081d58ad46b94767f8c`
- V2 commit that embedded the v1 backend before cleanup:
  - commit: `f25879c47e5fd488e4349a207e125d9ef306a81a`
  - path: `legacy/mongo-v1/`

The dedicated repository branch heads matched these commits on 2026-09-07.
The local v2 history also retains the embedded archive at the pinned commit.
Deleting the duplicate `legacy/mongo-v1/` files from the current tree does not
delete those snapshots. Use the pinned commits for behavior comparison and
source recovery rather than reintroducing the old application into the v2
runtime package.

## Evidence to record before production cutover

Record the installed v1 iOS application before replacing its backend or
shipping the v2 client. Use synthetic or personally owned test data and hide
notifications, passwords, tokens, addresses, phone numbers, and customer data.

Capture one continuous walkthrough where practical:

1. Device date and the Smart HomeCare app icon.
2. Cold launch and the initial screen.
3. Email or social sign-in without exposing credentials.
4. Service categories, asset illustrations, options, and pricing.
5. Date and time-slot selection.
6. Booking confirmation, using test data only.
7. Booking history and detail.
8. Settings, profile editing, and account-deletion entry point.
9. Administrator booking list and status update, if safely available.
10. App version/build information, including build 40 if that is the installed
    production build.

Also save screenshots or exports of:

- the App Store Connect app record, version history, availability, and review
  history;
- the Google Play Console app record and release history;
- sanitized deployment configuration names, without values;
- collection/table counts and the final migration reconciliation report;
- the V1 API contract and the V2 compatibility test result;
- any analytics that the owner is authorized to retain.

Use the actual recording date in the filename, for example
`SHC-v1-iOS-2026-09-07.mov`. This checklist does not claim that a recording or
production reconciliation has already been completed.

Keep at least two copies in owner-controlled locations. The recording is
portfolio evidence, not a substitute for the database backup or Git history.

## Cutover preservation rule

Do not delete or mutate the source MongoDB deployment as part of repository
cleanup. After the last export, retain it read-only for the agreed rollback
window. Remove migration compatibility fields only after production traffic,
identity mapping, booking history, and reconciliation have been verified.
