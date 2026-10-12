#!/usr/bin/env bash
# ============================================================================
#  Installation du relais TWS, en une seule commande.
#
#  Usage :  bash installer.sh <sous-domaine-duckdns> <token-duckdns>
#  Exemple : bash installer.sh selecthub d3198082-8500-488f-99a6-4bdd79420114
#
#  À lancer sur un serveur Debian 12/13 ou Ubuntu 22.04/24.04 fraîchement créé,
#  en tant que root. Le script fait tout : DuckDNS, Node, Caddy, le service, le
#  certificat HTTPS. Il se termine en affichant les deux valeurs dont tu as
#  besoin : l'adresse à donner à Supabase, et l'IP à faire déclarer par TGM.
#
#  Il est REJOUABLE : le relancer ne casse rien et conserve le secret déjà
#  généré — c'est ce qui permet de le relancer après une erreur sans avoir à
#  remettre à jour la configuration de Supabase.
# ============================================================================
set -euo pipefail

DEPOT="https://raw.githubusercontent.com/wathefr-maker/wathe-erp/main/relais"
TWS="https://wathe.rezomatic.com/soap/rezomaticSoapServer.php"

DOMAINE="${1:-}"; TOKEN="${2:-}"
if [ -z "$DOMAINE" ] || [ -z "$TOKEN" ]; then
  echo "Usage : bash installer.sh <sous-domaine-duckdns> <token-duckdns>" >&2
  echo "Exemple : bash installer.sh selecthub d3198082-8500-488f-99a6-4bdd79420114" >&2
  exit 1
fi
[ "$(id -u)" -eq 0 ] || { echo "À lancer en root (ou avec sudo)." >&2; exit 1; }
FQDN="$DOMAINE.duckdns.org"

etape() { printf "\n\033[1;34m==>\033[0m %s\n" "$*"; }

# ---------------------------------------------------------------- 1) l'adresse
etape "Adresse publique de ce serveur"
IP="$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me/ip)"
[ -n "$IP" ] || { echo "Impossible de déterminer l'IP publique." >&2; exit 1; }
echo "    $IP"

etape "Mise à jour de DuckDNS : $FQDN -> $IP"
REP="$(curl -fsS "https://www.duckdns.org/update?domains=${DOMAINE}&token=${TOKEN}&ip=${IP}")"
[ "$REP" = "OK" ] || { echo "DuckDNS a répondu « $REP ». Vérifie le sous-domaine et le token." >&2; exit 1; }
echo "    OK"

# DuckDNS est regénéré toutes les 5 minutes : inutile sur une IP fixe, mais
# gratuit en ressources et ça couvre le cas d'un changement d'adresse serveur.
cat > /etc/cron.d/duckdns <<CRON
*/5 * * * * root curl -fsS "https://www.duckdns.org/update?domains=${DOMAINE}&token=${TOKEN}&ip=" >/dev/null 2>&1
CRON
chmod 644 /etc/cron.d/duckdns

# ---------------------------------------------------------------- 2) paquets
etape "Installation des outils (1 à 2 minutes)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg openssl cron \
  debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 18 ]; then
  echo "    Node.js…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    Node $(node --version)"

if ! command -v caddy >/dev/null 2>&1; then
  echo "    Caddy…"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
echo "    Caddy $(caddy version | head -1)"

# ---------------------------------------------------------------- 3) le relais
etape "Mise en place du relais"
id relais >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin relais
mkdir -p /opt/relais-tws
curl -fsSL -o /opt/relais-tws/relais-tws.js "$DEPOT/relais-tws.js"
node --check /opt/relais-tws/relais-tws.js
chown -R relais:relais /opt/relais-tws

# Le secret n'est généré qu'une fois : le régénérer casserait l'adresse déjà
# enregistrée dans Supabase, pour aucun bénéfice.
SECRET=""
[ -f /etc/relais-tws.env ] && SECRET="$(grep -oP '(?<=^RELAIS_CHEMIN=).*' /etc/relais-tws.env || true)"
if [ -z "$SECRET" ]; then
  SECRET="$(openssl rand -hex 24)"
  echo "    secret généré"
else
  echo "    secret existant conservé"
fi
cat > /etc/relais-tws.env <<ENV
RELAIS_CHEMIN=$SECRET
TWS_URL=$TWS
PORT=8787
ENV
chmod 600 /etc/relais-tws.env
chown relais:relais /etc/relais-tws.env

curl -fsSL -o /etc/systemd/system/relais-tws.service "$DEPOT/relais-tws.service"
systemctl daemon-reload
systemctl enable relais-tws >/dev/null 2>&1
systemctl restart relais-tws

# ---------------------------------------------------------------- 4) HTTPS
etape "Certificat HTTPS pour $FQDN"
cat > /etc/caddy/Caddyfile <<CADDY
$FQDN {
    reverse_proxy 127.0.0.1:8787
}
CADDY
systemctl restart caddy

echo "    obtention du certificat, patiente…"
OK=""
for i in $(seq 1 30); do
  sleep 4
  if curl -fsS --max-time 8 "https://$FQDN/sante" 2>/dev/null | grep -q relais-tws; then OK="oui"; break; fi
done

# ---------------------------------------------------------------- 5) résultat
echo
if [ -z "$OK" ]; then
  echo "========================================================================"
  echo " Le relais tourne, mais le certificat HTTPS n'est pas encore prêt."
  echo " C'est presque toujours le DNS qui met quelques minutes à se propager."
  echo " Attends 5 minutes et teste :   https://$FQDN/sante"
  echo " Pour voir ce qui se passe  :   journalctl -u caddy -n 30 --no-pager"
  echo "========================================================================"
else
  echo "========================================================================"
  echo " C'EST EN LIGNE."
  echo
  echo " 1) Dans Supabase, crée le secret REZOMATIC_ENDPOINT avec cette valeur :"
  echo
  echo "      https://$FQDN/$SECRET"
  echo
  echo " 2) Demande à TGM de déclarer cette adresse IP :"
  echo
  echo "      $IP"
  echo
  echo "========================================================================"
fi
echo
echo " État du service : systemctl status relais-tws --no-pager"
echo " Derniers appels : journalctl -u relais-tws -n 30 --no-pager"
echo
