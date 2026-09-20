// `offset` is an absolute row count and wins over `page` when both arrive. Screens that open with
// one size and then fetch another (5 rows, then 10 at a time) cannot express their position as a
// page number, so they send where they are instead: offset=5&limit=10, offset=15&limit=10, …
function parsePagination(query) {
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50));
  const rawOffset = parseInt(query.offset, 10);
  if (Number.isFinite(rawOffset) && rawOffset >= 0) {
    const skip = rawOffset;
    return { page: Math.floor(skip / limit) + 1, limit, skip };
  }
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { page, limit, skip: (page - 1) * limit };
}

function paginatedResponse(docs, total, { page, limit }) {
  return {
    data: docs,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}

// Page a list that was COMPUTED in the service (holdings, aging, personal-cylinder history),
// never a raw slice of bills — replaying a partial history gives wrong numbers (R15-R17, R57).
// Called with no page AND no limit it returns the plain array, so existing callers that need the
// whole set (exports, printing, the rental calculator) keep working untouched.
function pageComputed(rows, { page, limit, offset } = {}) {
  if (page === undefined && limit === undefined && offset === undefined) return rows;
  const pg = parsePagination({ page, limit, offset });
  return paginatedResponse(rows.slice(pg.skip, pg.skip + pg.limit), rows.length, pg);
}

module.exports = { parsePagination, paginatedResponse, pageComputed };
