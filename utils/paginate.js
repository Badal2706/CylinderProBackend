function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
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

module.exports = { parsePagination, paginatedResponse };
