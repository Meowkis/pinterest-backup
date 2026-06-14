import assert from "node:assert/strict";
import test from "node:test";
import { extractAssets, parseBoardsPage, parsePinsPage } from "../src/pinterest/parser.js";

test("parses private boards and pagination bookmark", () => {
  const page = parseBoardsPage({
    resource_response: {
      status: "success",
      bookmark: "next-page",
      data: [{ id: "1", name: "Private", description: "Notes", url: "/me/private/", privacy: "secret" }],
    },
  });
  assert.equal(page.items[0]?.name, "Private");
  assert.equal(page.items[0]?.privacy, "secret");
  assert.equal(page.bookmark, "next-page");
});

test("parses pins and treats -end- as the last page", () => {
  const page = parsePinsPage({
    resource_response: {
      status: "success",
      bookmark: "-end-",
      data: [{ id: "10", grid_title: "A pin", description: "Description", images: {} }],
    },
  }, "1");
  assert.equal(page.items[0]?.title, "A pin");
  assert.equal(page.items[0]?.boardId, "1");
  assert.equal(page.bookmark, null);
});

test("selects the original image and the largest direct video", () => {
  const pin = parsePinsPage({
    resource_response: {
      status: "success",
      data: [{
        id: "10",
        images: { orig: { url: "https://i.pinimg.com/originals/a.jpg", width: 1000, height: 2000 } },
        carousel_data: {
          carousel_slots: [{
            videos: {
              video_list: {
                V_360P: { url: "https://v.pinimg.com/360.mp4", width: 360, height: 640 },
                V_720P: { url: "https://v.pinimg.com/720.mp4", width: 720, height: 1280 },
                V_HLS: { url: "https://v.pinimg.com/master.m3u8", width: 1080, height: 1920 },
              },
            },
          }],
        },
      }],
    },
  }, "1").items[0];

  assert.ok(pin);
  assert.deepEqual(extractAssets(pin).map(({ kind, remoteUrl }) => ({ kind, remoteUrl })), [
    { kind: "image", remoteUrl: "https://i.pinimg.com/originals/a.jpg" },
    { kind: "video", remoteUrl: "https://v.pinimg.com/720.mp4" },
  ]);
});
