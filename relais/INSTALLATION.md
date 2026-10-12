# Relais TWS — installation

Un petit serveur qui donne une **adresse IP fixe** aux appels vers la caisse
Rezomatic. TGM n'aura qu'une seule adresse à déclarer, une fois pour toutes.

Compte **30 minutes** la première fois. Suis les étapes dans l'ordre.

---

## Ce qu'il te faut avant de commencer

**1. Un serveur.** Le plus petit modèle suffit largement — le relais consomme
quelques mégaoctets. Prends **Debian 12** ou **Ubuntu 24.04**.

| Hébergeur | Modèle | Prix |
|---|---|---|
| Hetzner | CX22 | ~4 €/mois |
| Scaleway | DEV1-S | ~5 €/mois |
| OVH | VPS Starter | ~5 €/mois |

Note l'**adresse IP** du serveur dès la création : c'est elle que TGM devra
déclarer.

**2. Une adresse web.** Deux cas :

- **Tu as un nom de domaine** → crée un enregistrement `A` pour
  `tws.tondomaine.fr` qui pointe sur l'IP du serveur.
- **Tu n'en as pas** → va sur [duckdns.org](https://www.duckdns.org), connecte-toi,
  crée un nom (par exemple `wathe-tws`) et mets l'IP du serveur. Tu obtiens
  `wathe-tws.duckdns.org`, gratuitement. C'est parfaitement suffisant.

L'adresse web sert à obtenir un certificat HTTPS. Sans HTTPS, l'identifiant de
ta caisse circulerait en clair sur internet.

---

## Installation

Connecte-toi au serveur en SSH, puis colle les blocs **un par un**.

### 1. Les outils

```bash
apt update && apt install -y nodejs caddy curl
node --version    # doit afficher v18 ou plus
```

> Si `node --version` affiche moins que v18, installe une version récente :
> ```bash
> curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
> ```

### 2. Le compte de service et le dossier

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin relais
mkdir -p /opt/relais-tws
```

### 3. Le programme

Dépose `relais-tws.js` dans `/opt/relais-tws/` (par `scp`, ou colle-le avec
`nano /opt/relais-tws/relais-tws.js`), puis :

```bash
chown -R relais:relais /opt/relais-tws
```

### 4. Le secret

```bash
openssl rand -hex 24
```

Copie la suite de caractères affichée — **tu en auras besoin deux fois**.
Puis crée le fichier de configuration :

```bash
cat > /etc/relais-tws.env <<'FIN'
RELAIS_CHEMIN=COLLE_ICI_LE_SECRET
TWS_URL=https://wathe.rezomatic.com/soap/rezomaticSoapServer.php
PORT=8787
FIN
chmod 600 /etc/relais-tws.env
chown relais:relais /etc/relais-tws.env
```

Remplace `COLLE_ICI_LE_SECRET` par ce qu'a affiché `openssl`.

### 5. Le service

Dépose `relais-tws.service` dans `/etc/systemd/system/`, puis :

```bash
systemctl daemon-reload
systemctl enable --now relais-tws
systemctl status relais-tws --no-pager
```

Tu dois voir **`active (running)`** en vert.

### 6. Le HTTPS

Dépose `Caddyfile` dans `/etc/caddy/`, **en remplaçant `tws.exemple.fr` par ton
adresse** (celle du domaine ou celle de DuckDNS), puis :

```bash
systemctl reload caddy
```

Caddy obtient le certificat tout seul, ça prend quelques secondes.

### 7. Vérification

Depuis n'importe où (ton ordinateur, ton téléphone) :

```
https://TON-ADRESSE/sante
```

Tu dois lire : `{"ok":true,"service":"relais-tws"}`

Si c'est le cas, **le relais est en ligne**.

---

## Brancher l'ERP dessus

Ton adresse complète est :

```
https://TON-ADRESSE/LE-SECRET
```

Dans **Supabase → Settings → Edge Functions → Secrets**, crée :

| Nom | Valeur |
|---|---|
| `REZOMATIC_ENDPOINT` | `https://TON-ADRESSE/LE-SECRET` |

**Rien d'autre à faire.** Les trois fonctions lisent déjà ce secret en priorité :
aucun redéploiement, aucune modification de code.

---

## À dire à TGM

> Nos appels au Web Service partiront désormais d'une adresse IP fixe :
> **`<l'IP du serveur>`**. Pouvez-vous la déclarer dans la liste des adresses
> légitimes pour notre SESSIONID ?

---

## Si quelque chose ne va pas

```bash
journalctl -u relais-tws -n 50 --no-pager     # les derniers appels
systemctl restart relais-tws                   # redémarrer
```

Le journal montre une ligne par appel : `ok 200 164ms 312o`. Il ne contient
**jamais** le contenu des requêtes — chacune porte l'identifiant de ta caisse,
l'écrire dans un fichier reviendrait à le laisser traîner.

| Ce que tu vois | Ce que ça veut dire |
|---|---|
| `refus POST /abcd…` | Le secret dans l'URL ne correspond pas |
| `ECHEC délai dépassé` | La caisse ne répond pas dans les 30 secondes |
| `502` côté ERP | Le relais tourne mais n'a pas pu joindre la caisse |
| `invalide pour se connecter` | TGM n'a pas encore déclaré l'IP du serveur |
