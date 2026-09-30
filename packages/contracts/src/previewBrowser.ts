import { Schema } from "effect";
import { PreviewViewportSetting } from "./preview.ts";

const Coordinate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Modifiers = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }));
const Dimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3840 }));

export const PreviewBrowserClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("input_mouse"),
    eventType: Schema.Literals(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]),
    x: Coordinate,
    y: Coordinate,
    button: Schema.optional(Schema.Literals(["left", "middle", "right", "none"])),
    buttons: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 31 }))),
    clickCount: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
    modifiers: Schema.optional(Modifiers),
    deltaX: Schema.optional(Schema.Finite),
    deltaY: Schema.optional(Schema.Finite),
  }),
  Schema.Struct({
    type: Schema.Literal("input_keyboard"),
    eventType: Schema.Literals(["keyDown", "keyUp", "char"]),
    key: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
    code: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(65_536))),
    windowsVirtualKeyCode: Schema.optional(Schema.Int),
    modifiers: Schema.optional(Modifiers),
  }),
  Schema.Struct({
    type: Schema.Literal("input_touch"),
    eventType: Schema.Literals(["touchStart", "touchMove", "touchEnd", "touchCancel"]),
    touchPoints: Schema.Array(
      Schema.Struct({ x: Coordinate, y: Coordinate, id: Schema.optional(Schema.Int) }),
    ).check(Schema.isMaxLength(10)),
  }),
  Schema.Struct({ type: Schema.Literal("take_control") }),
  Schema.Struct({ type: Schema.Literal("release_control") }),
  Schema.Struct({
    type: Schema.Literal("navigate"),
    url: Schema.String.check(Schema.isMaxLength(2048)),
  }),
  Schema.Struct({ type: Schema.Literals(["back", "forward", "reload"]) }),
  Schema.Struct({ type: Schema.Literal("resize"), width: Dimension, height: Dimension }),
  Schema.Struct({
    type: Schema.Literal("set_viewport"),
    viewport: PreviewViewportSetting,
    width: Schema.optional(Dimension),
    height: Schema.optional(Dimension),
  }),
  Schema.Struct({
    type: Schema.Literal("set_color_scheme"),
    colorScheme: Schema.Literals(["system", "light", "dark"]),
  }),
  Schema.Struct({
    type: Schema.Literal("config"),
    maxFps: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 120 }))),
    pacing: Schema.optional(Schema.Literals(["ack", "push"])),
  }),
  Schema.Struct({
    type: Schema.Literal("ack"),
    seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
]);
export type PreviewBrowserClientMessage = typeof PreviewBrowserClientMessage.Type;

export const PreviewBrowserServerMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("frame"),
    seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    data: Schema.String,
    metadata: Schema.Struct({
      deviceWidth: Schema.Finite,
      deviceHeight: Schema.Finite,
      pageScaleFactor: Schema.optional(Schema.Finite),
      offsetTop: Schema.optional(Schema.Finite),
      scrollOffsetX: Schema.optional(Schema.Finite),
      scrollOffsetY: Schema.optional(Schema.Finite),
      timestamp: Schema.optional(Schema.Finite),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("status"),
    connected: Schema.Boolean,
    screencasting: Schema.Boolean,
    viewportWidth: Schema.optional(Schema.Finite),
    viewportHeight: Schema.optional(Schema.Finite),
    canGoBack: Schema.optional(Schema.Boolean),
    canGoForward: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("url"),
    url: Schema.String,
    timestamp: Schema.optional(Schema.Finite),
  }),
  Schema.Struct({
    type: Schema.Literal("control"),
    viewerId: Schema.String,
    controller: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("viewport"), viewport: PreviewViewportSetting }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
export type PreviewBrowserServerMessage = typeof PreviewBrowserServerMessage.Type;
