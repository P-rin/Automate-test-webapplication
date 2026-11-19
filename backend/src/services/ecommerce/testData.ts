/**
 * Synthetic test data for templates (ECOMMERCE_TESTGEN_CONTEXT.md §4c). Never real people, addresses or
 * cards; credentials come from env via "{{env.NAME}}" placeholders that the compiler expands.
 */
import { matchesAnyTerm } from "./keywords.js";
import type { InventoryElement } from "./types.js";

export const TEST_DATA = {
  fullName: "Test User",
  firstName: "Test",
  lastName: "User",
  phone: "0800000000",
  postalCode: "10110",
  email: "test+auto@example.com",
  street: "99 ถนนทดสอบ",
  district: "เขตทดสอบ",
  province: "กรุงเทพมหานคร",
  country: "ประเทศไทย",
  /** Standard public test card number (not a real card). */
  cardNumber: "4111111111111111",
  freeText: "ข้อความทดสอบอัตโนมัติ",
  notFoundTerm: "zzqxnotfound",
  invalidCoupon: "INVALID123",
  wrongPassword: "wrong-password-123",
  invalidEmails: ["abc", "abc@"],
  whitespace: "   ",
  defaultLongTextLength: 1000,
} as const;

export const ENV_EMAIL = "{{env.TEST_EMAIL}}";
export const ENV_PASSWORD = "{{env.TEST_PASSWORD}}";

/** A valid synthetic value for a form field, chosen by its purpose and label. */
export const validValueFor = (element: InventoryElement): string => {
  const label = `${element.name} ${element.attrs?.placeholder ?? ""} ${element.attrs?.htmlName ?? ""}`;
  switch (element.purpose) {
    case "email":
      return TEST_DATA.email;
    case "phone":
      return TEST_DATA.phone;
    case "postal_code":
      return TEST_DATA.postalCode;
    case "card_number":
      return TEST_DATA.cardNumber;
    case "name":
      if (matchesAnyTerm(label, ["first name", "given name", "firstname", "ชื่อจริง"])) return TEST_DATA.firstName;
      if (matchesAnyTerm(label, ["last name", "family name", "surname", "lastname", "นามสกุล"])) return TEST_DATA.lastName;
      return TEST_DATA.fullName;
    case "address":
      if (matchesAnyTerm(label, ["country", "ประเทศ"])) return TEST_DATA.country;
      if (matchesAnyTerm(label, ["province", "state", "จังหวัด"])) return TEST_DATA.province;
      if (matchesAnyTerm(label, ["district", "city", "เขต", "อำเภอ", "แขวง", "ตำบล"])) return TEST_DATA.district;
      return TEST_DATA.street;
    case "quantity":
      return "1";
    default:
      return TEST_DATA.freeText;
  }
};
