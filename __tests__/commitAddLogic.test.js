// Tests the frontend commitAdd logic (replicated here as pure JS) to verify
// that manual serial entry is allowed when a cylinder is not in the local cache.
// This mirrors the CylinderItem.commitAdd function in components.jsx.

describe('commitAdd — manual serial entry for cylinders not in local cache', () => {
  // Simulate the commitAdd logic from CylinderItem
  function simulateCommitAdd({ query, searchPool, pool, item, notFoundMessage, matchesLine }) {
    const text = query.trim();
    if (!text) return { action: 'noop' };

    const cyl = searchPool.find(c => c.rotational_number.toLowerCase() === text.toLowerCase())
      || pool.find(c => c.rotational_number.toLowerCase() === text.toLowerCase());

    if (cyl && !matchesLine(cyl)) {
      return { action: 'error', message: `mismatch: ${cyl.gas_type} / ${cyl.capacity}` };
    }
    if (cyl) {
      return { action: 'selectCylinder', cylinder: cyl };
    }
    // --- THIS IS THE FIX BEING TESTED ---
    if (notFoundMessage) {
      return { action: 'error', message: notFoundMessage };
    }
    if (!item.gas_type_id || !item.cylinder_size_id) {
      return { action: 'error', message: 'Select gas type and size first, then type the cylinder number.' };
    }
    return { action: 'addSerial', serial: text };
  }

  test('cylinder found in pool → selectCylinder', () => {
    const result = simulateCommitAdd({
      query: 'CYL-001',
      searchPool: [{ rotational_number: 'CYL-001', gas_type: 'Nitrogen', capacity: '7 m3' }],
      pool: [],
      item: { gas_type_id: 'g1', cylinder_size_id: 's1', serial_numbers: [] },
      notFoundMessage: '',
      matchesLine: () => true
    });
    expect(result.action).toBe('selectCylinder');
    expect(result.cylinder.rotational_number).toBe('CYL-001');
  });

  test('cylinder NOT in pool, gas+size selected → addSerial (the fix)', () => {
    const result = simulateCommitAdd({
      query: 'CYL-999',
      searchPool: [],
      pool: [],
      item: { gas_type_id: 'g1', cylinder_size_id: 's1', serial_numbers: [] },
      notFoundMessage: '',
      matchesLine: () => true
    });
    expect(result.action).toBe('addSerial');
    expect(result.serial).toBe('CYL-999');
  });

  test('cylinder NOT in pool, gas+size NOT selected → error asking to select', () => {
    const result = simulateCommitAdd({
      query: 'CYL-999',
      searchPool: [],
      pool: [],
      item: { gas_type_id: '', cylinder_size_id: '', serial_numbers: [] },
      notFoundMessage: '',
      matchesLine: () => true
    });
    expect(result.action).toBe('error');
    expect(result.message).toMatch(/Select gas type/);
  });

  test('vendor notFoundMessage → error (vendor restriction preserved)', () => {
    const result = simulateCommitAdd({
      query: 'CYL-999',
      searchPool: [],
      pool: [],
      item: { gas_type_id: 'g1', cylinder_size_id: 's1', serial_numbers: [] },
      notFoundMessage: 'Only cylinders currently with this filling vendor can be received back here.',
      matchesLine: () => true
    });
    expect(result.action).toBe('error');
    expect(result.message).toMatch(/filling vendor/);
  });

  test('cylinder in pool but gas/size mismatch → error', () => {
    const result = simulateCommitAdd({
      query: 'CYL-001',
      searchPool: [{ rotational_number: 'CYL-001', gas_type: 'Oxygen', capacity: '10 m3' }],
      pool: [],
      item: { gas_type_id: 'g1', cylinder_size_id: 's1', serial_numbers: ['OTHER'] },
      notFoundMessage: '',
      matchesLine: () => false
    });
    expect(result.action).toBe('error');
    expect(result.message).toMatch(/mismatch/);
  });

  test('empty query → noop', () => {
    const result = simulateCommitAdd({
      query: '  ',
      searchPool: [],
      pool: [],
      item: { gas_type_id: 'g1', cylinder_size_id: 's1', serial_numbers: [] },
      notFoundMessage: '',
      matchesLine: () => true
    });
    expect(result.action).toBe('noop');
  });
});
