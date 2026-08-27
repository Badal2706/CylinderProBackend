// ─── Legacy location lookup ───
// These three are GURU INDUSTRIES' OWN SITES. They are NOT a template for new accounts, and
// since GEN-B1 they are not the runtime source of truth either — LocationProfile is (R81).
//
// What they still do:
//   * give a historical code a human label where no LocationProfile row supplies one
//     (LocationProfile.pre('validate'), and the Phase 2/33 backfill scripts)
//   * nothing else
//
// A BRAND-NEW ACCOUNT MUST NOT INHERIT THEM. A new client has their own sites; seeding somebody
// else's would leave them deleting three plants they have never heard of — and locations cannot
// be deleted (F-07), only added. New accounts get DEFAULT_NEW_ACCOUNT_LOCATION below.
const LOCATIONS = ['AT_PLANT_CHANDISAR', 'AT_PALANPUR_OFFICE', 'AT_CHHAPI_OFFICE'];

const LOCATION_LABELS = {
  AT_PLANT_CHANDISAR: 'Chandisar Plant',
  AT_PALANPUR_OFFICE: 'Palanpur Office',
  AT_CHHAPI_OFFICE: 'Chhapi Office'
};

// What a brand-new account starts with: ONE generic site, flagged as the filling location.
//
// Not zero sites: DSR, Stock Summary, the maintenance gate and the filling log all pivot on a
// filling location, so an account with none is legal (R85) but half-functional, and a new client
// would meet errors before they met the product. One renameable site keeps the app working from
// the first minute, and renaming is already supported where deleting is not.
const DEFAULT_NEW_ACCOUNT_LOCATION = { code: 'AT_MAIN_PLANT', label: 'Main Plant' };

module.exports = { LOCATIONS, LOCATION_LABELS, DEFAULT_NEW_ACCOUNT_LOCATION };
