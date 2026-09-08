export function validateLineup(players, slots) {
  const available = new Map(players.map((p) => [p.id, p]));
  const errors = [];
  const seen = new Set();
  for (const assignment of slots) {
    const player = available.get(assignment.playerId);
    if (!player) errors.push(`Unknown player ${assignment.playerId}`);
    else if (seen.has(player.id)) errors.push(`${player.name} is assigned more than once`);
    else if (!assignment.eligiblePositions.includes(player.position)) errors.push(`${player.name} is not eligible for ${assignment.slot}`);
    seen.add(assignment.playerId);
  }
  return { legal: errors.length === 0, errors };
}

export function optimizeLineup(players, slots, objective = 'mean') {
  const used = new Set();
  const assignments = [];
  const ordered = [...slots].sort((a, b) => a.eligiblePositions.length - b.eligiblePositions.length);
  for (const slot of ordered) {
    const candidate = players.filter((p) => !used.has(p.id) && slot.eligiblePositions.includes(p.position))
      .sort((a, b) => Number(b.projection?.[objective] || 0) - Number(a.projection?.[objective] || 0))[0];
    if (candidate) { used.add(candidate.id); assignments.push({ slot: slot.name, playerId: candidate.id }); }
  }
  return assignments;
}
