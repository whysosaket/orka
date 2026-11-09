#!/usr/bin/env bash
set -euo pipefail

# Run on Ubuntu 24.04 with the ID of Orka's newly attached data volume.
if [[ ${EUID} -ne 0 || ! ${1:-} =~ ^vol-[0-9a-f]+$ ]]; then
  echo 'Usage: sudo bash bootstrap.sh vol-<data-volume-id>' >&2
  exit 1
fi

serial=${1//-/}
disk=$(lsblk -dnro NAME,SERIAL | awk -v serial="$serial" '$2 == serial {print "/dev/" $1}')
if [[ -z "$disk" || ! -b "$disk" ]]; then
  echo 'The specified EBS data volume is not attached.' >&2
  exit 1
fi
root_source=$(findmnt -nro SOURCE /)
root_disk=$(lsblk -nro PKNAME "$root_source" | head -1)
if [[ "$disk" == "$root_source" || "$disk" == "/dev/$root_disk" ]]; then
  echo 'Refusing to use the operating-system disk as the data volume.' >&2
  exit 1
fi

filesystem=$(blkid -s TYPE -o value "$disk" || true)
if [[ -z "$filesystem" ]]; then
  # Do not format a disk that has a partition table or child devices.
  if [[ -n $(blkid -s PTTYPE -o value "$disk" || true) || $(lsblk -nr "$disk" | wc -l) -ne 1 ]]; then
    echo 'The data disk is not blank; inspect it before mounting.' >&2
    exit 1
  fi
  mkfs.ext4 -L orka-data "$disk"
elif [[ "$filesystem" != ext4 ]]; then
  echo 'Existing data filesystem is not ext4; preserving it.' >&2
  exit 1
fi
uuid=$(blkid -s UUID -o value "$disk")
mkdir -p /srv/orka
if mountpoint -q /srv/orka; then
  if [[ $(findmnt -nro UUID /srv/orka) != "$uuid" ]]; then
    echo 'A different filesystem is already mounted at /srv/orka.' >&2
    exit 1
  fi
else
  if find /srv/orka -mindepth 1 -maxdepth 1 | read -r _; then
    echo '/srv/orka is not empty; refusing to hide existing data.' >&2
    exit 1
  fi
  if ! grep -q "^UUID=$uuid " /etc/fstab; then
    printf 'UUID=%s /srv/orka ext4 defaults 0 2\n' "$uuid" >> /etc/fstab
  fi
  mount /srv/orka
fi

export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=300 update
apt-get -o DPkg::Lock::Timeout=300 install -y docker.io docker-compose-v2 ca-certificates curl python3

mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/orka-data.conf <<'EOF'
[Unit]
RequiresMountsFor=/srv/orka
ConditionPathIsMountPoint=/srv/orka
EOF
systemctl daemon-reload
systemctl enable --now docker

if [[ ! -f /swapfile ]]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  swapon /swapfile
fi
if ! grep -q '^/swapfile ' /etc/fstab; then
  printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi

mkdir -p /srv/orka/postgres /srv/orka/blobs /srv/orka/caddy /srv/orka/backups
chown 1000:1000 /srv/orka/blobs
chmod 700 /srv/orka/blobs /srv/orka/backups
mkdir -p /opt/orka
chown ubuntu:ubuntu /opt/orka
docker --version
docker compose version
findmnt /srv/orka
