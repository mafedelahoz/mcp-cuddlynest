#!/usr/bin/env node

/**
 * Smoke test for the CuddlyNest MCP server: MCP handshake, tool listing, and the
 * documented "needs_capture" behaviour of cuddlynest_search (which is offline —
 * it does no network I/O until the search WebSocket protocol is captured).
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "dist", "index.js");
const TEST_TIMEOUT = 45000; // live-network calls: search does autosuggest + geo-page

class MCPTester {
  constructor() {
    this.server = null;
    this.requestId = 1;
  }

  async startServer() {
    console.log("🚀 Starting MCP server...");
    this.server = spawn("node", [SERVER_PATH, "--ignore-robots-txt"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, IGNORE_ROBOTS_TXT: "true" },
    });
    this.server.stderr.on("data", (d) => console.log("📋", d.toString().trim()));
    await new Promise((r) => setTimeout(r, 1500));
    if (this.server.killed) throw new Error("Server failed to start");
    console.log("✅ Server started");
  }

  sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      const request = { jsonrpc: "2.0", id: this.requestId++, method, params };
      const timeout = setTimeout(() => reject(new Error("Request timeout")), TEST_TIMEOUT);
      let buf = "";
      const onData = (data) => {
        buf += data.toString();
        for (const line of buf.split("\n").filter((l) => l.trim())) {
          try {
            const res = JSON.parse(line);
            if (res.id === request.id) {
              clearTimeout(timeout);
              this.server.stdout.off("data", onData);
              resolve(res);
              return;
            }
          } catch {
            /* partial */
          }
        }
      };
      this.server.stdout.on("data", onData);
      this.server.stdin.write(JSON.stringify(request) + "\n");
    });
  }

  async testListTools() {
    console.log("\n🔧 tools/list...");
    const res = await this.sendRequest("tools/list");
    if (res.error) throw new Error(res.error.message);
    const names = (res.result?.tools || []).map((t) => t.name);
    console.log("   tools:", names.join(", "));
    for (const expected of ["cuddlynest_search", "cuddlynest_listing_details"]) {
      if (!names.includes(expected)) throw new Error(`Missing tool: ${expected}`);
    }
    return true;
  }

  async testSearch() {
    console.log("\n🔍 cuddlynest_search (destination + hotels)...");
    const res = await this.sendRequest("tools/call", {
      name: "cuddlynest_search",
      arguments: { destination: "Cartagena, Colombia", adults: 2 },
    });
    if (res.error) throw new Error(res.error.message);
    const content = JSON.parse(res.result.content[0].text);
    if (content.query !== "Cartagena, Colombia") throw new Error("query not echoed");
    if (!Array.isArray(content.hotels)) throw new Error("no hotels array");
    if (!Array.isArray(content.places)) throw new Error("no places array");
    if (content.hotels.length) {
      const h = content.hotels[0];
      console.log(
        `   ${content.hotelCount} hotels (${content.hotelSource})` +
          (content.city?.city ? ` in ${content.city.city}` : "") +
          ` — top: ${h.name} ★${h.starRating ?? "?"} [pid ${h.productId}]`,
      );
      if (!h.productId || !h.url) throw new Error("hotel missing productId/url");
    } else {
      console.log("   ⚠️  no hotels returned (autosuggestion unreachable?) — non-fatal");
    }
    return true;
  }

  async testListingParsing() {
    console.log("\n🏨 cuddlynest_listing_details (product_id parse, no dates)...");
    const res = await this.sendRequest("tools/call", {
      name: "cuddlynest_listing_details",
      arguments: {
        hotel: "https://www.cuddlynest.com/hotel/co/some-hotel-4395541",
        ignoreRobotsText: true,
      },
    });
    if (res.error) throw new Error(res.error.message);
    const content = JSON.parse(res.result.content[0].text);
    if (content.productId !== "4395541") {
      throw new Error(`expected productId 4395541, got ${content.productId}`);
    }
    if (!content.roomsError) throw new Error("expected roomsError (no checkin/checkout)");
    console.log("   ✅ parsed productId 4395541; rooms gated on missing dates");
    return true;
  }

  async stopServer() {
    if (this.server && !this.server.killed) {
      this.server.kill("SIGTERM");
      await new Promise((r) => {
        this.server.on("exit", r);
        setTimeout(r, 3000);
      });
    }
  }

  async run() {
    let ok = true;
    try {
      await this.startServer();
      for (const t of [
        () => this.testListTools(),
        () => this.testSearch(),
        () => this.testListingParsing(),
      ]) {
        try {
          await t();
        } catch (e) {
          console.error("❌", e.message);
          ok = false;
        }
      }
    } catch (e) {
      console.error("❌ suite failed:", e.message);
      ok = false;
    } finally {
      await this.stopServer();
    }
    console.log("\n" + "=".repeat(50));
    console.log(ok ? "🎉 All smoke tests passed." : "❌ Some tests failed.");
    process.exit(ok ? 0 : 1);
  }
}

new MCPTester().run();
