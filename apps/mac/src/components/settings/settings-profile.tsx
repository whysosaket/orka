import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CopyIcon,
  MailIcon,
  PencilIcon,
  SignOutIcon,
} from "@primer/octicons-react";
import type { Snapshot } from "../../types.js";
import type { AccountProfile } from "../onboarding/model.js";
import { photoData } from "../onboarding/profile-step.js";
import { Button } from "../button.js";
import { Icon } from "../icon.js";
import { TextField } from "../text-field.js";
import { CopyLinkButton } from "../copy-link-button.js";
import { ActivityIndicator } from "../activity-indicator.js";
import { LoadingRegion } from "../loading-region.js";
import { SettingsAccount } from "./settings-account.js";
import { Overlay } from "../overlay.js";
import { PermissionSelect } from "../permission-select.js";
import { SettingsHeading, type SettingsEditor } from "./settings-shared.js";
import { useSettingsQuery } from "./use-settings-query.js";

type Profile = AccountProfile & { email?: string };
const sample: Profile = {
  displayName: "Morgan Taylor",
  jobRole: "Designer",
  email: "morgan@example.com",
};
const profileFields = ["displayName", "jobRole", "photo"] as const;
type ProfileField = (typeof profileFields)[number];
const fieldValue = (profile: Profile, field: ProfileField) =>
  field === "photo"
    ? JSON.stringify([profile.avatarData ?? null, profile.avatarUrl ?? null])
    : (profile[field] ?? "");
const fieldLabel = {
  displayName: "Display name",
  jobRole: "Job role",
  photo: "Photo",
};
function ProfileFields({
  profile,
  disabled,
  onChange,
  onPhoto,
}: {
  profile: Profile;
  disabled: boolean;
  onChange: (value: Profile) => void;
  onPhoto: () => void;
}) {
  const avatar = profile.avatarData ?? profile.avatarPreview;
  return (
    <div className="settings-profile-fields">
      <button
        type="button"
        className="settings-avatar"
        disabled={disabled}
        aria-label="Change profile photo"
        onClick={onPhoto}
      >
        {avatar ? (
          <img src={avatar} alt="" width={72} height={72} />
        ) : (
          <span>
            {profile.displayName.trim().slice(0, 1).toUpperCase() || "?"}
          </span>
        )}
        <span className="settings-avatar-edit">
          <PencilIcon size={10} />
        </span>
      </button>
      <div className="settings-profile-inputs">
        <div className="settings-field-pair">
          <TextField
            label="Display name"
            size="lg"
            value={profile.displayName}
            maxLength={80}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...profile, displayName: event.target.value })
            }
          />
          <TextField
            label="Job role"
            size="lg"
            value={profile.jobRole ?? ""}
            maxLength={80}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...profile, jobRole: event.target.value })
            }
          />
        </div>
        <TextField
          label="Email"
          icon={MailIcon}
          size="lg"
          value={profile.email || "Unavailable from this service"}
          readOnly
        />
      </div>
    </div>
  );
}

export const SettingsProfile = forwardRef<
  SettingsEditor,
  {
    state: Snapshot;
    onSignedOut: () => void;
    onSignOut: () => void;
    run: (action: () => Promise<unknown>, message?: string) => Promise<boolean>;
    onServiceDirty: (dirty: boolean) => void;
    onStartService: (action: () => void) => void;
  }
>(function SettingsProfile(
  { state, onSignedOut, onSignOut, run, onServiceDirty, onStartService },
  ref,
) {
  const user = state.user,
    service = state.config?.apiUrl;
  const context = useCallback(() => ({ user, service }), [user, service]);
  const load = useCallback(async () => {
    const profile = await invoke<Profile>("onboarding_command", {
      action: "profile",
      input: {},
      context: context(),
    });
    if (typeof profile?.displayName !== "string")
      throw new Error("The service returned an invalid profile.");
    return profile;
  }, [context]);
  const query = useSettingsQuery(load, state.accountProfile ?? null);
  const [baseline, setBaseline] = useState<Profile | null>(
    state.accountProfile ?? null,
  );
  const [draft, setDraft] = useState<Profile | null>(null);
  const [review, setReview] = useState<{
    latest: Profile;
    choices: Partial<Record<ProfileField, "draft" | "latest">>;
  } | null>(null);
  const [saving, setSaving] = useState(false),
    [preparing, setPreparing] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const active = useRef(true),
    locked = useRef(false),
    file = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (query.data && !draftRef.current) setBaseline(query.data);
  }, [query.data]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const value = draft ?? baseline ?? query.data;
  const base = baseline ?? query.data;
  const editable = query.data?.detailsSupported !== false;
  const dirty = Boolean(
    draft &&
    JSON.stringify([
      draft.displayName,
      draft.jobRole ?? "",
      draft.avatarData,
      draft.avatarUrl,
    ]) !==
      JSON.stringify([
        base?.displayName,
        base?.jobRole ?? "",
        base?.avatarData,
        base?.avatarUrl,
      ]),
  );
  async function save(): Promise<true | string> {
    if (!dirty) return true;
    if (!editable) return "This service does not support profile edits yet.";
    if (locked.current || preparing || !value)
      return "Wait for the current profile operation to finish.";
    locked.current = true;
    setSaving(true);
    setError("");
    try {
      const latest = await load();
      if (!active.current) return "The profile is no longer open.";
      if (
        base &&
        profileFields.some(
          (field) => fieldValue(base, field) !== fieldValue(latest, field),
        )
      ) {
        setReview({ latest, choices: {} });
        return "Your profile changed elsewhere. Stay on this page to review the latest values.";
      }
      const result = await invoke<Profile>("onboarding_command", {
        action: "save-settings-profile",
        input: {
          displayName: value.displayName,
          jobRole: value.jobRole,
          avatarData: value.avatarData,
          avatarUrl: value.avatarUrl,
          expectedRevision: latest.revision,
        },
        context: context(),
      });
      if (!active.current) return "The profile is no longer open.";
      setBaseline(result);
      query.confirm(result);
      setDraft(null);
      setSaved(true);
      return true;
    } catch (error) {
      if (active.current) setError(String(error));
      return String(error);
    } finally {
      locked.current = false;
      if (active.current) setSaving(false);
    }
  }
  useImperativeHandle(ref, () => ({
    dirty,
    save,
    discard: () => {
      setDraft(null);
      setError("");
    },
  }));
  return (
    <>
      <SettingsHeading
        title="Profile"
        description="Manage your profile and account."
        action={
          <Button
            variant="primary"
            disabled={!editable || !dirty || saving || preparing}
            onClick={() => void save()}
          >
            {saving && <ActivityIndicator />}
            {saving ? "Saving…" : "Save profile"}
          </Button>
        }
      />
      <LoadingRegion
        id="settings-profile"
        label="Loading profile…"
        data={value}
        sample={sample}
        loading={!value && query.loading}
        error={
          !value && query.error ? (
            <p role="alert">
              {query.error}{" "}
              <Button onClick={() => void query.refresh()}>Retry</Button>
            </p>
          ) : undefined
        }
      >
        {(profile) => (
          <ProfileFields
            profile={profile}
            disabled={!editable || saving || preparing}
            onChange={(next) => {
              setDraft(next);
              setError("");
              setSaved(false);
            }}
            onPhoto={() => file.current?.click()}
          />
        )}
      </LoadingRegion>
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        aria-label="Upload profile photo"
        disabled={!editable || saving || preparing}
        onChange={(event) => {
          const selected = event.target.files?.[0];
          event.target.value = "";
          if (!selected || !value || locked.current) return;
          setPreparing(true);
          setError("");
          void photoData(selected)
            .then((avatarData) => {
              if (active.current)
                setDraft({
                  ...value,
                  avatarData,
                  avatarUrl: null,
                  avatarPreview: null,
                });
            })
            .catch((error) => {
              if (active.current) setError(String(error));
            })
            .finally(() => {
              if (active.current) setPreparing(false);
            });
        }}
      />
      {preparing && <p role="status">Preparing photo…</p>}
      {!editable && (
        <p role="status">
          This service does not support profile edits yet. Update the service to
          edit your profile.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Profile saved.</p>}
      {query.extended && (
        <p>Still loading your profile. You can use the other settings.</p>
      )}
      {query.error && value && (
        <p role="alert">
          Couldn’t refresh your profile.{" "}
          <Button size="sm" onClick={() => void query.refresh()}>
            Retry
          </Button>
        </p>
      )}
      {review && value && base && (
        <Overlay
          open
          title="Review latest profile"
          className="settings-migration"
          onClose={() => setReview(null)}
        >
          <h2>Review latest profile</h2>
          <p>Your draft is kept. Unedited fields use the latest profile.</p>
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Your draft</th>
                <th>Latest</th>
                <th>Resolution</th>
              </tr>
            </thead>
            <tbody>
              {profileFields.map((field) => {
                const edited =
                  fieldValue(value, field) !== fieldValue(base, field);
                const conflict =
                  edited &&
                  fieldValue(review.latest, field) !==
                    fieldValue(base, field) &&
                  fieldValue(review.latest, field) !== fieldValue(value, field);
                const display = (profile: Profile) =>
                  field === "photo" ? (
                    profile.avatarData || profile.avatarUrl ? (
                      <img
                        src={profile.avatarData ?? profile.avatarUrl!}
                        alt="Profile photo"
                        width={48}
                        height={48}
                      />
                    ) : (
                      "No photo"
                    )
                  ) : (
                    fieldValue(profile, field) || "Not set"
                  );
                return (
                  <tr key={field}>
                    <td>{fieldLabel[field]}</td>
                    <td>{display(value)}</td>
                    <td>{display(review.latest)}</td>
                    <td>
                      {conflict ? (
                        <PermissionSelect
                          label={`Resolve ${fieldLabel[field]}`}
                          value={review.choices[field] ?? ""}
                          placeholder="Choose"
                          options={[
                            { value: "draft", label: "Keep my edit" },
                            { value: "latest", label: "Use latest" },
                          ]}
                          onChange={(choice) =>
                            setReview({
                              ...review,
                              choices: {
                                ...review.choices,
                                [field]: choice as "draft" | "latest",
                              },
                            })
                          }
                        />
                      ) : edited ? (
                        "Keep my edit"
                      ) : (
                        "Use latest"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="settings-confirm-actions">
            <Button onClick={() => setReview(null)}>Stay</Button>
            <Button
              variant="primary"
              disabled={profileFields.some(
                (field) =>
                  fieldValue(value, field) !== fieldValue(base, field) &&
                  fieldValue(review.latest, field) !==
                    fieldValue(base, field) &&
                  fieldValue(review.latest, field) !==
                    fieldValue(value, field) &&
                  !review.choices[field],
              )}
              onClick={() => {
                const next = { ...review.latest };
                for (const field of profileFields)
                  if (
                    fieldValue(value, field) !== fieldValue(base, field) &&
                    review.choices[field] !== "latest"
                  ) {
                    if (field === "photo") {
                      next.avatarData = value.avatarData;
                      next.avatarUrl = value.avatarUrl;
                      next.avatarPreview = value.avatarPreview;
                    } else next[field] = value[field] ?? "";
                  }
                setBaseline(review.latest);
                query.confirm(review.latest);
                setDraft(next);
                setReview(null);
                setError("");
              }}
            >
              Use reviewed values
            </Button>
          </div>
        </Overlay>
      )}
      <section aria-label="Account" className="settings-account-rows">
        <h3>Account</h3>
        <SettingsAccount
          state={state}
          busy={saving}
          run={run}
          onDirty={onServiceDirty}
          onSignedOut={onSignedOut}
          onStart={onStartService}
        />
        <div className="settings-row">
          <div>
            <h3>Account ID</h3>
            <p>Share this when contacting support.</p>
          </div>
          <code className="settings-copy-value">
            {state.user}
            <CopyLinkButton
              value={state.user ?? ""}
              label="Copy Account ID"
              icon={CopyIcon}
              iconOnly
              onError={setError}
            />
          </code>
        </div>
        <div className="settings-row">
          <div>
            <h3>Sign out</h3>
            <p>Sign out on this Mac.</p>
          </div>
          <Button
            variant="secondary"
            className="settings-sign-out"
            disabled={saving}
            onClick={onSignOut}
          >
            <Icon icon={SignOutIcon} />
            Sign out
          </Button>
        </div>
      </section>
    </>
  );
});
