function familyForType(type) {
  return type.startsWith("work") ? "work" : "chat";
}
function normExtractedFamily(raw) {
  return raw === "chat" || raw === "work" ? raw : void 0;
}
function resolveRecordFamily(forced, extracted, type) {
  return forced ?? normExtractedFamily(extracted) ?? familyForType(type);
}
export {
  familyForType,
  normExtractedFamily,
  resolveRecordFamily
};
