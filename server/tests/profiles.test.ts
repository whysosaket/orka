import test from "node:test";
import assert from "node:assert/strict";
import {
  profileInput,
  remoteKey,
  validAvatarData,
} from "./reference/profiles.js";
await test("onboarding profiles accept only names and GitHub avatar URLs", () => {
  assert.equal(
    profileInput.parse({
      displayName: " Pratham ",
      avatarUrl: "https://avatars.githubusercontent.com/u/123",
      source: "github",
      ifAbsent: true,
    }).displayName,
    "Pratham",
  );
  for (const avatarUrl of [
    "http://avatars.githubusercontent.com/u/1",
    "https://avatars.githubusercontent.com.evil.test/u/1",
    "https://user@avatars.githubusercontent.com/u/1",
    "https://avatars.githubusercontent.com:8443/u/1",
    "https://example.com/avatar",
  ])
    assert.equal(
      profileInput.safeParse({ displayName: "A", avatarUrl, source: "user" })
        .success,
      false,
    );
  for (const displayName of ["", " ", "a".repeat(81)])
    assert.equal(
      profileInput.safeParse({ displayName, source: "user" }).success,
      false,
    );
  assert.equal(
    profileInput.safeParse({ displayName: "A", source: "user", extra: 1 })
      .success,
    false,
  );
  assert.equal(remoteKey.safeParse("a".repeat(64)).success, true);
  for (const key of ["", "A".repeat(64), "a".repeat(63)])
    assert.equal(remoteKey.safeParse(key).success, false);
});

await test("uploaded photos are bounded PNGs and job roles never grant project access", () => {
  const photo =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  assert.equal(validAvatarData(photo), true);
  assert.equal(
    profileInput.parse({
      displayName: "Alex",
      source: "user",
      jobRole: " Designer ",
      avatarData: photo,
    }).jobRole,
    "Designer",
  );
  for (const value of [
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/png;base64,aGVsbG8=",
    photo + "!",
    "https://example.test/photo",
  ])
    assert.equal(validAvatarData(value), false);
  const large = Buffer.from(photo.split(",")[1], "base64");
  large.writeUInt32BE(513, 16);
  assert.equal(
    validAvatarData("data:image/png;base64," + large.toString("base64")),
    false,
  );
  assert.equal(
    profileInput.safeParse({ displayName: "A", source: "user", role: "owner" })
      .success,
    false,
  );
  assert.equal(
    profileInput.safeParse({
      displayName: "A",
      source: "user",
      jobRole: "a".repeat(81),
    }).success,
    false,
  );
});
