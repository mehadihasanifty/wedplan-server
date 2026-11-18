import { ObjectId } from "mongodb";

export function idOptions(id) {
  const value = String(id ?? "");
  const options = [value];
  if (ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) options.push(new ObjectId(value));
  return options;
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
