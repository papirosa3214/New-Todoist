import { describe, it, expect } from "vitest";
import { ofxProvider } from "../src/importers/ofx";

describe("ofxProvider", () => {
  it("разбирает OFX SGML v1 c STMTTRN", async () => {
    const content = [
      "OFXHEADER:100",
      "DATA:OFXSGML",
      "VERSION:102",
      "<OFX>",
      "<BANKMSGSRSV1><STMTTRNRS><TRNUID>1",
      "<STMTRS><CURDEF>RUB<BANKACCTFROM><BANKID>044<Plaid>40702810<ACCTID>CARD001</BANKACCTFROM>",
      "<BANKTRANLIST>",
      "<DTSTART>20261001<DTEND>20261031",
      "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-100.50<FITID>ABC123<NAME>STORE<MEMO>оплата покупки</STMTTRN>",
      "<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261006<TRNAMT>5000<FITID>ABC124<NAME>SALARY<MEMO>оклад</STMTTRN>",
      "</BANKTRANLIST>",
      "</STMTRS>",
      "</STMTTRNRS></BANKMSGSRSV1>",
      "</OFX>",
    ].join("\n");

    const out = await ofxProvider.parse(content);
    expect(out.operations).toHaveLength(2);
    expect(out.operations[0].amount).toBeCloseTo(-100.5);
    expect(out.operations[0].externalId).toBe("ABC123");
    expect(out.operations[0].date).toBe("2026-10-05");
    expect(out.operations[1].amount).toBeCloseTo(5000);
    expect(out.operations[1].externalId).toBe("ABC124");
  });

  it("возвращает предупреждение для не-OFX", async () => {
    const out = await ofxProvider.parse("Это не OFX");
    expect(out.operations).toHaveLength(0);
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});