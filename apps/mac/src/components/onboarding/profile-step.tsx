import React, { useEffect, useRef, useState } from "react";
import { Button } from "../button.js";
import { TextField } from "../text-field.js";
import { PermissionSelect } from "../permission-select.js";
import {
  OnboardingAuthLayout,
  OnboardingError,
  onboardingAsset,
} from "../onboarding-auth-layout.js";
import type { AccountProfile } from "./model.js";
const jobRoles = [
  { value: "engineering", label: "Developer" },
  { value: "design", label: "Designer" },
  { value: "product", label: "Product" },
  { value: "founder", label: "Founder" },
  { value: "other", label: "Other" },
];
const roleValue = (value?: string | null) =>
  jobRoles.find(
    (role) =>
      role.label.toLowerCase() === value?.toLowerCase() || role.value === value,
  )?.value ??
  value ??
  "";

async function photoData(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Choose a PNG, JPEG, or WebP photo.");
  if (file.size > 10 * 1024 * 1024)
    throw new Error("Choose a photo smaller than 10 MB.");
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn’t read this photo."));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const value = new Image();
    value.onload = () => resolve(value);
    value.onerror = () => reject(new Error("Couldn’t open this photo."));
    value.src = source;
  });
  if (!image.naturalWidth || !image.naturalHeight)
    throw new Error("Choose a valid photo.");
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Couldn’t prepare this photo.");
  const crop = Math.min(image.naturalWidth, image.naturalHeight);
  context.drawImage(
    image,
    (image.naturalWidth - crop) / 2,
    (image.naturalHeight - crop) / 2,
    crop,
    crop,
    0,
    0,
    256,
    256,
  );
  return canvas.toDataURL("image/png");
}
export function ProfileStep({
  profile,
  ready,
  busy,
  error,
  onSave,
}: {
  profile: AccountProfile | null;
  ready: boolean;
  busy: boolean;
  error: string;
  onSave: (profile: AccountProfile) => void;
}) {
  const [name, setName] = useState(profile?.displayName ?? "");
  const [role, setRole] = useState(roleValue(profile?.jobRole));
  const [photo, setPhoto] = useState<string | null>(
    profile?.avatarData ?? null,
  );
  const [photoError, setPhotoError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dirty = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    heading.current?.focus();
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (profile && !dirty.current) {
      setName(profile.displayName);
      setRole(roleValue(profile.jobRole));
      setPhoto(profile.avatarData ?? null);
    }
  }, [profile]);
  const disabled = busy || !ready || preparing;
  const canSubmit = Boolean(name.trim() && role.trim());
  return (
    <OnboardingAuthLayout
      busy={disabled}
      className="onboarding-profile"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && canSubmit)
          onSave({
            displayName: name.trim(),
            jobRole: role.trim(),
            avatarData: photo,
            avatarUrl: photo ? null : (profile?.avatarUrl ?? null),
          });
      }}
    >
      <header className="onboarding-entry__header">
        <div className="onboarding-entry__heading">
          <h1 id="onboarding-entry-title" ref={heading} tabIndex={-1}>
            Set up your profile
          </h1>
          <p className="onboarding-profile__description">
            Add your name and a photo so teammates can recognize you.
          </p>
        </div>
      </header>
      <div className="onboarding-profile__photo">
        <button
          type="button"
          disabled={disabled}
          className="onboarding-profile__avatar"
          aria-label="Change profile photo"
          onClick={() => file.current?.click()}
        >
          <img
            src={
              photo ??
              profile?.avatarPreview ??
              onboardingAsset("profile-placeholder.png")
            }
            width={72}
            height={72}
            alt="Profile photo"
          />
          <span className="onboarding-profile__edit">
            <img
              src={onboardingAsset("edit-pencil.svg")}
              width={8.571}
              height={8.571}
              alt=""
            />
          </span>
        </button>
        <input
          ref={file}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          tabIndex={-1}
          aria-label="Upload profile photo"
          disabled={disabled}
          onChange={(event) => {
            const selected = event.target.files?.[0];
            event.target.value = "";
            if (!selected) return;
            setPhotoError("");
            setPreparing(true);
            void photoData(selected)
              .then((value) => {
                if (active.current) {
                  dirty.current = true;
                  setPhoto(value);
                }
              })
              .catch((e) => {
                if (active.current)
                  setPhotoError(String(e).replace(/^Error:\s*/, ""));
              })
              .finally(() => {
                if (active.current) setPreparing(false);
              });
          }}
        />
      </div>
      <div className="onboarding-profile__form">
        <div className="onboarding-entry__email">
          <TextField
            className="onboarding-entry__field"
            label="Your Name"
            required
            maxLength={80}
            autoComplete="name"
            value={name}
            disabled={disabled}
            onChange={(event) => {
              dirty.current = true;
              setName(event.target.value);
            }}
          />
          <div className="onboarding-profile__role">
            <span className="onboarding-profile__label">Role</span>
            <PermissionSelect
              label="Role"
              required
              value={role}
              disabled={disabled}
              placeholder="Select your role"
              icon={
                <img
                  src={onboardingAsset("chevron-down.svg")}
                  width={16}
                  height={16}
                  alt=""
                />
              }
              options={
                jobRoles.some((option) => option.value === role) || !role
                  ? jobRoles
                  : [...jobRoles, { value: role, label: role }]
              }
              onChange={(value) => {
                dirty.current = true;
                setRole(value);
              }}
            />
          </div>
        </div>
        {ready && profile?.detailsSupported === false && (
          <p className="onboarding-entry__message" role="status">
            Your server needs an update. Profile changes will sync after it’s
            updated.
          </p>
        )}
        <OnboardingError>{photoError || error}</OnboardingError>
        <Button
          type="submit"
          variant="primary"
          className="onboarding-entry__submit"
          disabled={disabled || !canSubmit}
        >
          {preparing
            ? "Preparing photo…"
            : !ready
              ? "Loading…"
              : busy
                ? "Saving…"
                : "Setup Profile"}
        </Button>
      </div>
    </OnboardingAuthLayout>
  );
}
