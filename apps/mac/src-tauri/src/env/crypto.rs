pub use crate::db::hex;
use crate::db::{self, Result};
use age::secrecy::ExposeSecret;
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand::TryRng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    io::{Read, Write},
};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

pub const MAX_BYTES: usize = 1_000_000;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Device {
    pub id: String,
    pub owner: String,
    pub name: String,
    pub encryption_key: String,
    pub signing_key: String,
}
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct Keys {
    #[zeroize(skip)]
    pub device: Device,
    encryption_secret: String,
    signing_secret: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub format: u8,
    pub project_id: String,
    pub set_id: String,
    pub device: Device,
    pub nonce: String,
    pub expires_at: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Approval {
    pub request: Request,
    pub signature: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format: u8,
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    pub set_id: String,
    pub name: String,
    pub creator: String,
    pub revision: u64,
    pub access_revision: u64,
    pub grants: Vec<String>,
    pub devices: Vec<Device>,
    pub approvals: Vec<Approval>,
    pub author_device_id: String,
    pub previous_hash: String,
    pub ciphertext_hash: String,
    pub deleted: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub manifest: Manifest,
    pub signature: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Version {
    pub manifest: Manifest,
    pub signature: String,
    pub ciphertext: String,
}
impl Version {
    pub fn header(&self) -> Header {
        Header {
            manifest: self.manifest.clone(),
            signature: self.signature.clone(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadResponse {
    pub version: Version,
    pub chain: Vec<Header>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pin {
    pub root_hash: String,
    pub head_hash: String,
    pub revision: u64,
}

pub fn canonical(value: &impl Serialize) -> Result<String> {
    // Going through Value sorts object fields; serialized structs retain declaration order.
    serde_json::to_value(value)
        .map(|v| v.to_string())
        .map_err(|_| "Invalid ENV metadata".into())
}
pub fn hash(value: &impl Serialize) -> Result<String> {
    Ok(db::digest(canonical(value)?.as_bytes()))
}
fn unhex<const N: usize>(raw: &str) -> Result<[u8; N]> {
    if raw.len() != N * 2
        || !raw
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("Invalid ENV key or signature".into());
    }
    let mut bytes = [0u8; N];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&raw[i * 2..i * 2 + 2], 16).map_err(|_| "Invalid ENV key")?;
    }
    Ok(bytes)
}
impl Keys {
    pub fn generate(owner: &str, name: &str) -> Self {
        let encryption = age::x25519::Identity::generate();
        let mut signing_seed = Zeroizing::new([0u8; 32]);
        rand::rngs::SysRng
            .try_fill_bytes(signing_seed.as_mut())
            .expect("OS randomness is required for ENV signing keys");
        let signing = SigningKey::from_bytes(&signing_seed);
        Self {
            device: Device {
                id: uuid::Uuid::new_v4().to_string(),
                owner: owner.into(),
                name: name.into(),
                encryption_key: encryption.to_public().to_string(),
                signing_key: hex(signing.verifying_key().as_bytes()),
            },
            encryption_secret: encryption.to_string().expose_secret().to_string(),
            signing_secret: hex(&signing.to_bytes()),
        }
    }
    pub fn sign(&self, value: &impl Serialize) -> Result<String> {
        let bytes = Zeroizing::new(unhex::<32>(&self.signing_secret)?);
        let signing = SigningKey::from_bytes(&bytes);
        Ok(hex(&signing.sign(canonical(value)?.as_bytes()).to_bytes()))
    }
    pub fn decrypt(&self, encoded: &str) -> Result<Zeroizing<Vec<u8>>> {
        let ciphertext = decode_ciphertext(encoded)?;
        let identity: age::x25519::Identity = self
            .encryption_secret
            .parse()
            .map_err(|_| "Cannot read ENV private key")?;
        let decryptor = age::Decryptor::new(ciphertext.as_slice())
            .map_err(|_| "Invalid encrypted ENV payload")?;
        let reader = decryptor
            .decrypt(std::iter::once(&identity as &dyn age::Identity))
            .map_err(|_| "This Mac cannot decrypt this ENV set")?;
        let mut bytes = Zeroizing::new(Vec::new());
        reader
            .take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "ENV payload authentication failed")?;
        if bytes.len() > MAX_BYTES {
            return Err("ENV set exceeds 1 MB".into());
        }
        Ok(bytes)
    }
}
pub fn verify(device: &Device, value: &impl Serialize, raw: &str) -> Result<()> {
    let key = VerifyingKey::from_bytes(&unhex::<32>(&device.signing_key)?)
        .map_err(|_| "Invalid ENV signing key")?;
    key.verify_strict(
        canonical(value)?.as_bytes(),
        &Signature::from_bytes(&unhex::<64>(raw)?),
    )
    .map_err(|_| "ENV signature verification failed".into())
}
pub fn encrypt(bytes: &[u8], devices: &[Device]) -> Result<String> {
    if bytes.len() > MAX_BYTES {
        return Err("ENV set exceeds 1 MB".into());
    }
    let recipients = devices
        .iter()
        .map(|d| {
            d.encryption_key
                .parse::<age::x25519::Recipient>()
                .map_err(|_| "Invalid ENV recipient key".to_string())
        })
        .collect::<Result<Vec<_>>>()?;
    let encryptor =
        age::Encryptor::with_recipients(recipients.iter().map(|r| r as &dyn age::Recipient))
            .map_err(|_| "ENV set needs an approved recipient")?;
    let mut output = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut output)
        .map_err(|_| "ENV encryption failed")?;
    writer
        .write_all(bytes)
        .map_err(|_| "ENV encryption failed")?;
    writer.finish().map_err(|_| "ENV encryption failed")?;
    Ok(STANDARD.encode(output))
}
pub fn decode_ciphertext(raw: &str) -> Result<Vec<u8>> {
    if raw.len() > 1_600_000 {
        return Err("Encrypted ENV set exceeds size limit".into());
    }
    STANDARD
        .decode(raw)
        .map_err(|_| "Invalid encrypted ENV encoding".into())
}
fn access(manifest: &Manifest) -> Value {
    json!({"grants":manifest.grants,"devices":manifest.devices,"approvals":manifest.approvals})
}
pub fn validate_transition(previous: Option<&Manifest>, next: &Manifest) -> Result<()> {
    let invalid = || "Invalid ENV authorization transition".to_string();
    let unique = |v: Vec<&str>| v.iter().copied().collect::<BTreeSet<_>>().len() == v.len();
    if next.format != 1
        || next.revision > 9_007_199_254_740_991
        || next.access_revision > 9_007_199_254_740_991
        || next.grants.is_empty()
        || next.grants.len() > 100
        || next.devices.is_empty()
        || next.devices.len() > 200
        || next.approvals.len() > 200
        || !unique(next.grants.iter().map(String::as_str).collect())
        || !unique(next.devices.iter().map(|d| d.id.as_str()).collect())
        || !unique(
            next.approvals
                .iter()
                .map(|a| a.request.device.id.as_str())
                .collect(),
        )
        || !unique(
            next.approvals
                .iter()
                .map(|a| a.request.nonce.as_str())
                .collect(),
        )
        || !next.grants.contains(&next.creator)
        || next.devices.iter().any(|d| !next.grants.contains(&d.owner))
    {
        return Err(invalid());
    }
    let author = previous
        .unwrap_or(next)
        .devices
        .iter()
        .find(|d| d.id == next.author_device_id)
        .ok_or_else(invalid)?;
    let Some(old) = previous else {
        if next.revision != 1
            || next.access_revision != 1
            || !next.previous_hash.is_empty()
            || next.deleted
            || author.owner != next.creator
            || next.devices.len() != 1
            || !next.approvals.is_empty()
        {
            return Err(invalid());
        }
        return Ok(());
    };
    if old.deleted
        || next.creator != old.creator
        || next.project_id != old.project_id
        || next.source_id.as_ref().unwrap_or(&next.project_id)
            != old.source_id.as_ref().unwrap_or(&old.project_id)
        || next.set_id != old.set_id
        || next.revision != old.revision + 1
        || !old.grants.contains(&author.owner)
        || next.access_revision != old.access_revision + u64::from(access(old) != access(next))
    {
        return Err(invalid());
    }
    if author.owner != old.creator
        && (next.deleted || next.name != old.name || next.grants != old.grants)
    {
        return Err(invalid());
    }
    for device in &next.devices {
        if let Some(prior) = old.devices.iter().find(|d| d.id == device.id) {
            if device != prior {
                return Err(invalid());
            }
        } else {
            let approval = next
                .approvals
                .iter()
                .find(|a| a.request.device.id == device.id)
                .ok_or_else(invalid)?;
            if &approval.request.device != device
                || approval.request.project_id != next.project_id
                || approval.request.set_id != next.set_id
                || (author.owner != old.creator && author.owner != device.owner)
            {
                return Err(invalid());
            }
        }
    }
    if author.owner != old.creator
        && old
            .devices
            .iter()
            .any(|d| !next.devices.iter().any(|n| n.id == d.id) && d.owner != author.owner)
    {
        return Err(invalid());
    }
    for approval in &next.approvals {
        if approval.request.format != 1 || !next.devices.contains(&approval.request.device) {
            return Err(invalid());
        }
        if let Some(prior) = old
            .approvals
            .iter()
            .find(|a| a.request.device.id == approval.request.device.id)
        {
            if approval != prior {
                return Err(invalid());
            }
        }
        verify(
            &approval.request.device,
            &approval.request,
            &approval.signature,
        )?;
    }
    for approval in &old.approvals {
        if next
            .devices
            .iter()
            .any(|d| d.id == approval.request.device.id)
            && !next.approvals.contains(approval)
        {
            return Err(invalid());
        }
    }
    Ok(())
}
pub fn verify_chain(response: &ReadResponse, pin: &Pin, project: &str, set: &str) -> Result<Pin> {
    let fail =
        || "ENV trust verification failed; use a fresh approval from a trusted Mac".to_string();
    if pin.revision == 0
        || response.chain.is_empty()
        || hash(&response.chain[0])? != pin.root_hash
        || response.chain.len() < pin.revision as usize
    {
        return Err(fail());
    }
    if hash(
        response
            .chain
            .get(pin.revision as usize - 1)
            .ok_or_else(fail)?,
    )? != pin.head_hash
    {
        return Err(fail());
    }
    let mut previous: Option<&Header> = None;
    for header in &response.chain {
        let manifest = &header.manifest;
        if manifest.project_id != project
            || manifest.set_id != set
            || manifest.previous_hash != previous.map(hash).transpose()?.unwrap_or_default()
        {
            return Err(fail());
        }
        validate_transition(previous.map(|h| &h.manifest), manifest)?;
        let author = previous
            .map(|h| &h.manifest)
            .unwrap_or(manifest)
            .devices
            .iter()
            .find(|d| d.id == manifest.author_device_id)
            .ok_or_else(fail)?;
        verify(author, manifest, &header.signature)?;
        previous = Some(header);
    }
    let head = response.chain.last().ok_or_else(fail)?;
    if &response.version.header() != head
        || head.manifest.deleted
        || db::digest(&decode_ciphertext(&response.version.ciphertext)?)
            != head.manifest.ciphertext_hash
    {
        return Err(fail());
    }
    Ok(Pin {
        root_hash: pin.root_hash.clone(),
        head_hash: hash(head)?,
        revision: head.manifest.revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_signature_matches_typescript_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../node_modules/@portable/protocol/fixtures/env-signature.json"
        ))
        .unwrap();
        assert_eq!(
            canonical(&fixture["value"]).unwrap(),
            fixture["canonical"].as_str().unwrap()
        );
        let mut key = Keys::generate("fixture", "Fixture Mac");
        key.signing_secret = fixture["seedHex"].as_str().unwrap().into();
        key.device.signing_key = fixture["publicKey"].as_str().unwrap().into();
        assert_eq!(
            key.sign(&fixture["value"]).unwrap(),
            fixture["signature"].as_str().unwrap()
        );
        verify(
            &key.device,
            &fixture["value"],
            fixture["signature"].as_str().unwrap(),
        )
        .unwrap();
    }
    #[test]
    fn chain_verification_rejects_forgery_rollback_and_cross_project_swaps() {
        let owner = Keys::generate("owner", "Owner");
        let recipient = Keys::generate("recipient", "Recipient");
        let ciphertext = encrypt(b"[]", std::slice::from_ref(&owner.device)).unwrap();
        let manifest = Manifest {
            format: 1,
            project_id: "project".into(),
            source_id: None,
            set_id: "set".into(),
            name: "Development".into(),
            creator: "owner".into(),
            revision: 1,
            access_revision: 1,
            grants: vec!["owner".into(), "recipient".into()],
            devices: vec![owner.device.clone()],
            approvals: vec![],
            author_device_id: owner.device.id.clone(),
            previous_hash: String::new(),
            ciphertext_hash: db::digest(&decode_ciphertext(&ciphertext).unwrap()),
            deleted: false,
        };
        let first = Header {
            signature: owner.sign(&manifest).unwrap(),
            manifest,
        };
        let root = hash(&first).unwrap();
        let pin = Pin {
            root_hash: root.clone(),
            head_hash: root,
            revision: 1,
        };
        let request = Request {
            format: 1,
            project_id: "project".into(),
            set_id: "set".into(),
            device: recipient.device.clone(),
            nonce: "nonce".into(),
            expires_at: 1,
        };
        let mut next = first.manifest.clone();
        next.revision = 2;
        next.access_revision = 2;
        next.previous_hash = hash(&first).unwrap();
        next.devices.push(recipient.device.clone());
        next.approvals.push(Approval {
            signature: recipient.sign(&request).unwrap(),
            request,
        });
        let ciphertext = encrypt(b"[secret]", &next.devices).unwrap();
        next.ciphertext_hash = db::digest(&decode_ciphertext(&ciphertext).unwrap());
        let second = Header {
            signature: owner.sign(&next).unwrap(),
            manifest: next,
        };
        let response = ReadResponse {
            version: Version {
                manifest: second.manifest.clone(),
                signature: second.signature.clone(),
                ciphertext,
            },
            chain: vec![first.clone(), second.clone()],
        };
        let latest = verify_chain(&response, &pin, "project", "set").unwrap();
        assert_eq!(latest.revision, 2);
        assert!(verify_chain(&response, &pin, "other", "set").is_err());
        let mut bad = response.clone();
        bad.chain[1].manifest.grants.push("outsider".into());
        assert!(verify_chain(&bad, &pin, "project", "set").is_err());
        let mut bad = response.clone();
        bad.chain[1].signature = recipient.sign(&second.manifest).unwrap();
        assert!(verify_chain(&bad, &pin, "project", "set").is_err());
        let mut bad = response.clone();
        bad.chain.remove(1);
        assert!(verify_chain(&bad, &latest, "project", "set").is_err());
        let mut bad = response.clone();
        bad.version.ciphertext = encrypt(b"forged", &second.manifest.devices).unwrap();
        assert!(verify_chain(&bad, &pin, "project", "set").is_err());
        let mut bad = response.clone();
        bad.chain[0].manifest.devices[0] = recipient.device.clone();
        assert!(verify_chain(&bad, &pin, "project", "set").is_err());
    }
    #[test]
    fn signatures_encryption_and_recipient_isolation() {
        let a = Keys::generate("a", "A");
        let b = Keys::generate("b", "B");
        let outsider = Keys::generate("c", "C");
        let value = json!({"z": [3, true], "a": "秘密\n\"\\"});
        let signature = a.sign(&value).unwrap();
        verify(&a.device, &value, &signature).unwrap();
        assert!(verify(&b.device, &value, &signature).is_err());
        assert!(verify(&a.device, &json!({"a": "tampered"}), &signature).is_err());
        let devices = vec![a.device.clone(), b.device.clone()];
        let encrypted = encrypt(b"CANARY=never-in-cloud", &devices).unwrap();
        assert_ne!(
            encrypted,
            encrypt(b"CANARY=never-in-cloud", &devices).unwrap()
        );
        assert_eq!(&*a.decrypt(&encrypted).unwrap(), b"CANARY=never-in-cloud");
        assert_eq!(&*b.decrypt(&encrypted).unwrap(), b"CANARY=never-in-cloud");
        assert!(outsider.decrypt(&encrypted).is_err());
        let mut corrupt = decode_ciphertext(&encrypted).unwrap();
        *corrupt.last_mut().unwrap() ^= 1;
        assert!(a.decrypt(&STANDARD.encode(corrupt)).is_err());
    }
}
