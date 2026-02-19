# Host Preparation

This guide helps you move host SSH off port 22 so Clawdfather can own port 22.

## Table of Contents

- [Ubuntu (including systemd ssh.socket gotcha)](#ubuntu-including-systemd-sshsocket-gotcha)
- [General Linux (UFW / firewalld)](#general-linux-ufw--firewalld)

---

## Ubuntu (including systemd ssh.socket gotcha)

### 1) Move sshd to port 2222

Edit `/etc/ssh/sshd_config`:

```bash
sudo nano /etc/ssh/sshd_config
```

Set:

```text
Port 2222
```

### 2) Ubuntu/systemd socket-activation gotcha

If `sshd_config` is set to `Port 2222` but SSH still listens on port 22, your system is likely using `ssh.socket`.

Run:

```bash
# Disable socket activation on port 22
sudo systemctl disable --now ssh.socket

# Run sshd as a normal service (reads sshd_config Port 2222)
sudo systemctl enable --now ssh.service
sudo systemctl restart ssh.service

# Verify listeners
sudo ss -tulpn | grep -E ':22 |:2222 '
```

Expected result:
- `:2222` is bound by `sshd`
- `:22` is no longer bound by `sshd` (free for Clawdfather)

### 3) Firewall

```bash
sudo ufw allow 2222/tcp
sudo ufw reload
```

### 4) Safety check (critical)

Before closing your current SSH session, test in a **new terminal**:

```bash
ssh -p 2222 user@clawdfather.ai
```

Only proceed once this succeeds.

---

## General Linux (UFW / firewalld)

### 1) Move sshd to 2222

Edit `/etc/ssh/sshd_config` and set:

```text
Port 2222
```

### 2) If using SELinux

```bash
sudo semanage port -a -t ssh_port_t -p tcp 2222
```

### 3) Firewall

UFW:

```bash
sudo ufw allow 2222/tcp
sudo ufw reload
```

firewalld:

```bash
sudo firewall-cmd --permanent --add-port=2222/tcp
sudo firewall-cmd --reload
```

### 4) Restart sshd

```bash
sudo systemctl restart sshd
```

### 5) Safety check (critical)

```bash
ssh -p 2222 user@clawdfather.ai
```

Keep your current shell open until this works.
