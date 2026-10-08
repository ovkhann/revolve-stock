# Revolve Realm Stock

Appli de gestion de stock de Revolve Realm (PWA). Les données restent dans le téléphone (IndexedDB) : aucune donnée n'est stockée dans ce dépôt.

## Mise en ligne (GitHub Pages)
1. Mets tous ces fichiers à la racine du dépôt.
2. Settings → Pages → Source : « Deploy from a branch », branche `main`, dossier `/ (root)`.
3. L'appli est disponible sur `https://<ton-pseudo>.github.io/<nom-du-depot>/`.

## Installation sur iPhone
Ouvre l'adresse dans Safari → Partager → « Sur l'écran d'accueil ».
Au premier lancement, importe le fichier de sauvegarde `.json`.

## Mise à jour
Remplace les fichiers et incrémente `VERSION` dans `sw.js` (ex. `rr-v2`) pour que l'appli se mette à jour sur le téléphone.

## Chat (Revolve Chat)
- Serveur : Supabase, projet `revolve-chat` (région Paris). Schéma : `supabase/schema.sql`, fonction de notifications : `supabase/functions/push/index.ts`.
- `chat-config.js` contient l'URL et la clé publique (anon) : elles sont faites pour être publiques, la sécurité est assurée par les règles d'accès.
- Le premier compte créé devient admin et choisit le code d'invitation.
