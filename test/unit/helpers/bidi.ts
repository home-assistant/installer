import { expect } from "@open-wc/testing";

/**
 * Expect the identifier on `line`, such as a drive path, to read left to right
 * in a right-to-left page: its first character left of its last. Unisolated,
 * "/dev/sda" shows as "dev/sda/". The line still starts on the right, like
 * the text around it.
 */
export function expectReadsLeftToRight(line: Element) {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let text = walker.nextNode() as Text;
  while (!text.data.trim()) text = walker.nextNode() as Text;
  const first = text.data.length - text.data.trimStart().length;
  const last = text.data.trimEnd().length - 1;
  const left = (offset: number) => {
    const range = document.createRange();
    range.setStart(text, offset);
    range.setEnd(text, offset + 1);
    return range.getBoundingClientRect().left;
  };
  expect(left(first), text.data.trim()).to.be.below(left(last));

  const content = document.createRange();
  content.selectNodeContents(line);
  expect(content.getBoundingClientRect().right).to.be.closeTo(
    line.getBoundingClientRect().right,
    1
  );
}
