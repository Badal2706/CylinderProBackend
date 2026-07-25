// Physical sites of the business. Used by Cylinder.location and Bill location fields.
// NOTE: duplicated in the frontend (App.jsx LOCATIONS) — keep both in sync manually,
// same convention as gasCapacities.js / GAS_CAPACITIES.
const LOCATIONS = ['AT_PLANT_CHANDISAR', 'AT_PALANPUR_OFFICE', 'AT_CHHAPI_OFFICE'];

const LOCATION_LABELS = {
  AT_PLANT_CHANDISAR: 'Chandisar Plant',
  AT_PALANPUR_OFFICE: 'Palanpur Office',
  AT_CHHAPI_OFFICE: 'Chhapi Office'
};

module.exports = { LOCATIONS, LOCATION_LABELS };
