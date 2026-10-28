export function connectionItems(value) {
  const hasItems = value && typeof value === 'object' && Object.hasOwn(value, 'items');
  const items = hasItems ? value.items : value;
  if (!Array.isArray(items)) throw new Error('Connections must contain an items array or be a legacy array.');
  if (items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('Connection records must be objects.');
  }
  return items;
}
