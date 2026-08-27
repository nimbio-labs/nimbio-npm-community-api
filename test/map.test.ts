/**
 * Coverage for the community map and gate geofences.
 *
 * The rule worth protecting here is that a radius below 100 m is REJECTED, not
 * clamped: Android's Geofence API and iOS region monitoring both degrade below
 * that, so a smaller fence would read as configured and never fire. The client
 * must forward the small value unchanged and let the 422 reach the caller —
 * "helpfully" raising it here would hand back a fence nobody asked for.
 */
import { describe, expect, it } from "vitest";
import { GEOFENCE_MODES, NimbioClient } from "../src/index.js";
import { mockFetch, TEST_KEY } from "./helpers.js";

function client(responses: Parameters<typeof mockFetch>[0]) {
  const mf = mockFetch(responses);
  return { client: new NimbioClient(TEST_KEY, { fetch: mf.fetchImpl }), calls: mf.calls };
}

const POINT = { latitude: 36.1699, longitude: -115.1398 };

const GEOFENCE = {
  enabled: true,
  center: POINT,
  radius_meters: 150,
  min_radius_meters: 100,
  mode: "prompt",
  updated_by_account_id: "a1b2",
  updated_datetime: "2026-08-18T17:04:11+00:00",
};

const MAP_LATCH = {
  latch_id: "l1",
  latch_name: "Main Gate",
  box_id: "b1",
  box_location: POINT,
  geofence: GEOFENCE,
};

describe("community map", () => {
  it("map() reads the community centre, its devices and every gate's fence", async () => {
    const { client: c, calls } = client({
      body: {
        result: "ok",
        request_id: "r1",
        community_location: POINT,
        min_radius_meters: 100,
        geofence_modes: ["prompt", "auto_open"],
        boxes: [
          { box_id: "b1", box_name: "Front Entry", location: POINT, latches: [MAP_LATCH] },
        ],
      },
    });

    const map = await c.community.map();

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v1/community/map");
    expect(map.communityLocation!.latitude).toBe(36.1699);
    expect(map.minRadiusMeters).toBe(100);
    // The server's own vocabulary, which the shipped constant mirrors.
    expect(map.geofenceModes).toEqual([...GEOFENCE_MODES]);
    const latch = map.boxes[0]!.latches[0]!;
    expect(latch.latchName).toBe("Main Gate");
    expect(latch.geofence!.radiusMeters).toBe(150);
    expect(latch.geofence!.mode).toBe("prompt");
  });

  it("a gate with no fence yet points at its device's location as the centre", async () => {
    const { client: c } = client({
      body: {
        result: "ok",
        community_location: POINT,
        min_radius_meters: 100,
        geofence_modes: ["prompt", "auto_open"],
        boxes: [
          {
            box_id: "b1",
            box_name: "Front Entry",
            location: POINT,
            latches: [
              { ...MAP_LATCH, geofence: { ...GEOFENCE, center: null, enabled: false } },
            ],
          },
        ],
      },
    });

    const latch = (await c.community.map()).boxes[0]!.latches[0]!;

    // center: null means "never configured" — boxLocation is the suggestion.
    expect(latch.geofence!.center).toBeNull();
    expect(latch.boxLocation!.longitude).toBe(-115.1398);
  });

  it("updateGeofence() is a partial update: only what you send travels", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", request_id: "r1", latch: MAP_LATCH },
    });

    const result = await c.community.updateGeofence("l1", { enabled: true });

    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/v1/community/latches/l1/geofence");
    // Nothing invented to pad the body — there is deliberately no way to clear
    // a configured centre through this surface.
    expect(calls[0]!.body).toEqual({ enabled: true });
    expect(result.latchId).toBe("l1");
    // The response always echoes the effective radius.
    expect(result.geofence!.radiusMeters).toBe(150);
  });

  it("latitude and longitude travel together, in WGS84 decimal degrees", async () => {
    const { client: c, calls } = client({
      body: { result: "ok", latch: MAP_LATCH },
    });

    await c.community.updateGeofence("l1", {
      latitude: 36.1699,
      longitude: -115.1398,
      radiusMeters: 150,
      mode: "auto_open",
    });

    expect(calls[0]!.body).toEqual({
      latitude: 36.1699,
      longitude: -115.1398,
      radius_meters: 150,
      mode: "auto_open",
    });
  });

  it("a radius under the minimum is forwarded and rejected, never clamped", async () => {
    const { client: c, calls } = client({
      status: 422,
      body: {
        error: {
          code: "radius_below_minimum",
          message: "radius must be at least 100 meters",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.updateGeofence("l1", { radiusMeters: 25 }),
    ).rejects.toMatchObject({ code: "radius_below_minimum", status: 422 });

    // 25, not 100: the client must not quietly raise it. A clamped write would
    // report success for a fence the caller never asked for, and the caller
    // would never learn their 25 m fence was impossible.
    expect(calls[0]!.body).toEqual({ radius_meters: 25 });
  });

  it("an empty body is the server's 400 nothing_to_update", async () => {
    const { client: c, calls } = client({
      status: 400,
      body: {
        error: {
          code: "nothing_to_update",
          message: "Supply at least one of: lat+long, radius, enabled, mode",
          request_id: "r1",
        },
      },
    });

    await expect(c.community.updateGeofence("l1", {})).rejects.toMatchObject({
      code: "nothing_to_update",
      status: 400,
    });
    expect(calls[0]!.body).toEqual({});
  });

  it("enabling a fence on a gate with no centre is the server's refusal", async () => {
    const { client: c } = client({
      status: 422,
      body: {
        error: {
          code: "geofence_center_required",
          message: "Set a centre before enabling this geofence",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.updateGeofence("l1", { enabled: true }),
    ).rejects.toMatchObject({ code: "geofence_center_required" });
  });

  it("a simulated write moves no real gate's fence", async () => {
    const { client: c } = client({
      body: {
        result: "simulated",
        latch_id: "l1",
        would_set: { radius_meters: 200, enabled: true },
        min_radius_meters: 100,
        request_id: "r1",
      },
    });

    const result = await c.community.updateGeofence("l1", {
      radiusMeters: 200,
      enabled: true,
    });

    expect(result.simulated).toBe(true);
    expect(result.latch).toBeNull();
    // latchId and the minimum still resolve, so a caller can log the outcome
    // without branching on the envelope shape.
    expect(result.latchId).toBe("l1");
    expect(result.minRadiusMeters).toBe(100);
    expect(result.wouldSet).toEqual({ radius_meters: 200, enabled: true });
  });

  it("an unknown gate is a 404 scoped to your community", async () => {
    const { client: c } = client({
      status: 404,
      body: {
        error: {
          code: "latch_not_found",
          message: "Latch not found in this community",
          request_id: "r1",
        },
      },
    });

    await expect(
      c.community.updateGeofence("not-mine", { enabled: false }),
    ).rejects.toMatchObject({ code: "latch_not_found", status: 404 });
  });
});
