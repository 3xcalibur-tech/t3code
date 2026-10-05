import { Editor } from "@tiptap/core";
import { TaskList } from "@tiptap/extension-task-list";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDocJson,
  ComposerListExtensions,
  ComposerTaskItemExtension,
  serializeEditorDoc,
  splitOrLiftListItem,
} from "./composer-rich-text-doc";

/**
 * Splits the last item of `value` the way Shift+Enter does, types `b`, and
 * returns the stored Markdown. Tiptap carries every attribute left at the
 * default `keepOnSplit: true` onto the new item and merges the overrides on
 * top, so the new item must keep the source marker, indent and spacing.
 */
function makeEditor(value: string) {
  return new Editor({
    extensions: [
      StarterKit.configure({
        bulletList: false,
        orderedList: false,
        listItem: false,
        codeBlock: false,
        trailingNode: false,
      }),
      ...ComposerListExtensions,
      TaskList,
      ComposerTaskItemExtension,
    ],
    content: buildDocJson(value, (name) => ({ label: name, description: null })),
  });
}

function splitLastItem(value: string, type: "listItem" | "taskItem", overrides: object) {
  const editor = makeEditor(value);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
  editor.commands.splitListItem(type, overrides);
  editor.view.dispatch(editor.state.tr.insertText("b"));
  return serializeEditorDoc(editor.state.doc).value;
}

describe("splitting a list item", () => {
  it.each([
    ["* a", { space: " " }, "* a\n* b"],
    ["+ a", { space: " " }, "+ a\n+ b"],
    ["- p\n  - a", { space: " " }, "- p\n  - a\n  - b"],
    ["3) a", { marker: "4)", space: " " }, "3) a\n4) b"],
  ])("keeps the source marker and indent of %s", (value, overrides, expected) => {
    expect(splitLastItem(value, "listItem", overrides)).toBe(expected);
  });

  it("keeps the indent of a nested task", () => {
    expect(splitLastItem("- [ ] p\n  - [ ] a", "taskItem", { checked: false })).toBe(
      "- [ ] p\n  - [ ] a\n  - [ ] b",
    );
  });
});

describe("Shift+Enter twice on an item", () => {
  // The second Shift+Enter lifts the new empty item one level. The stored
  // draft must write it at its new depth, so a rebuild from that draft gives
  // back the document the user is looking at.
  it.each([
    ["- a\n  - x", "- a\n  - x\n- b"],
    ["* a\n  * x", "* a\n  * x\n* b"],
    ["1. a\n   1. x", "1. a\n   1. x\n2. b"],
    ["- a\n  - x\n- c", "- a\n  - x\n- b\n- c"],
    ["- a\n  - x\n  - y", "- a\n  - x\n- b\n  - y"],
    ["- [ ] a\n  - [ ] x", "- [ ] a\n  - [ ] x\n- [ ] b"],
    ["- [x] a\n  - [ ] x\n- [ ] c", "- [x] a\n  - [ ] x\n- [ ] b\n- [ ] c"],
  ])("after x in %j writes %j", (value, expected) => {
    const editor = makeEditor(value);
    let caret = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "x") caret = pos + 1;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, caret)),
    );
    expect(splitOrLiftListItem(editor)).toBe(true);
    expect(splitOrLiftListItem(editor)).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText("b"));
    const stored = serializeEditorDoc(editor.state.doc).value;
    expect(stored).toBe(expected);
    // Same nesting after a rebuild; spacing defaults may differ but write the same.
    expect(makeEditor(stored).state.doc.toString()).toBe(editor.state.doc.toString());
  });
});
