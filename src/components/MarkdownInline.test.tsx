import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownInline } from "./MarkdownInline";

describe("<MarkdownInline> рендер", () => {
  it("оборачивает результат в span по умолчанию", () => {
    const html = renderToStaticMarkup(<MarkdownInline source="hello" />);
    expect(html).toBe("<span>hello</span>");
  });

  it("уважает as='h1'", () => {
    const html = renderToStaticMarkup(
      <MarkdownInline source="**title**" as="h1" />,
    );
    expect(html).toBe("<h1><strong>title</strong></h1>");
  });

  it("null даёт пустой span", () => {
    const html = renderToStaticMarkup(<MarkdownInline source={null} />);
    expect(html).toBe("<span></span>");
  });

  it("одни звёздочки-без-пары показывает как plain text", () => {
    const html = renderToStaticMarkup(
      <MarkdownInline source="*foo" />,
    );
    expect(html).toBe("<span>*foo</span>");
  });

  it("жирный/курсив/ссылка/код вместе", () => {
    const html = renderToStaticMarkup(
      <MarkdownInline source="**b**, *i*, `c`, [l](https://x.io)" />,
    );
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<em>i</em>");
    expect(html).toContain('<code class="md-inline-code">c</code>');
    expect(html).toContain('href="https://x.io"');
    expect(html).toContain(">l</a>");
  });

  it("XSS-вектор не превращается в HTML", () => {
    const html = renderToStaticMarkup(
      <MarkdownInline source="<script>alert(1)</script>" />,
    );
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});