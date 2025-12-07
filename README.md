# Voice to Text - Extension Chrome + n8n

Extension Chrome qui capture votre voix et l'envoie a un workflow n8n pour transcription (Mistral Voxtral) et nettoyage automatique.

## Fonctionnalites

- **Capture vocale** : Enregistrement audio via le microphone
- **Hotkey configurable** : Ctrl+Shift+V par defaut
- **Feedback visuel** : Badge sur l'icone (rouge = enregistrement, orange = traitement)
- **Transcription IA** : Utilise Mistral AI pour la transcription
- **Nettoyage automatique** : Supprime les hesitations et structure le texte
- **Injection automatique** : Le texte nettoye est insere dans le champ actif

## Structure du projet

```
Voice_to_text_ext/
├── extension/                 # Extension Chrome
│   ├── manifest.json         # Configuration de l'extension
│   ├── background.js         # Service worker
│   ├── content.js            # Script d'injection
│   ├── popup.html            # Interface de configuration
│   ├── popup.css             # Styles de la popup
│   ├── popup.js              # Logique de la popup
│   └── icons/                # Icones de l'extension
│       ├── icon16.svg
│       ├── icon48.svg
│       └── icon128.svg
├── n8n-workflow.json         # Workflow n8n a importer
├── generate-icons.html       # Generateur d'icones PNG
├── .env.example              # Template de configuration
└── README.md                 # Ce fichier
```

## Installation

### 1. Configurer n8n

1. **Installer n8n** si ce n'est pas deja fait :
   ```bash
   npm install -g n8n
   # ou
   docker run -it --rm --name n8n -p 5678:5678 n8nio/n8n
   ```

2. **Configurer la variable d'environnement** :
   - Copiez `.env.example` en `.env`
   - Ajoutez votre cle API Mistral : `MISTRAL_API_KEY=votre_cle`
   - Dans n8n, allez dans Settings > Environment Variables et ajoutez `MISTRAL_API_KEY`

3. **Importer le workflow** :
   - Ouvrez n8n (http://localhost:5678)
   - Cliquez sur "+ New Workflow"
   - Menu (3 points) > Import from File
   - Selectionnez `n8n-workflow.json`
   - Activez le workflow (toggle en haut a droite)

4. **Recuperer l'URL du webhook** :
   - Cliquez sur le node "Webhook"
   - Copiez l'URL de production (ex: `https://votre-n8n.com/webhook/voice-to-text`)

### 2. Generer les icones PNG

1. Ouvrez `generate-icons.html` dans votre navigateur
2. Cliquez sur chaque bouton pour telecharger les icones
3. Placez les fichiers PNG dans `extension/icons/`

### 3. Installer l'extension Chrome

1. Ouvrez Chrome et allez a `chrome://extensions/`
2. Activez le "Mode developpeur" (en haut a droite)
3. Cliquez sur "Charger l'extension non empaquetee"
4. Selectionnez le dossier `extension/`

### 4. Configurer l'extension

1. Cliquez sur l'icone de l'extension
2. Entrez l'URL du webhook n8n
3. Cliquez sur "Tester la connexion" pour verifier
4. Cliquez sur "Sauvegarder"

## Utilisation

1. **Placez votre curseur** dans un champ de texte (input, textarea, ou element editable)
2. **Appuyez sur Ctrl+Shift+V** pour demarrer l'enregistrement
3. **Parlez** votre message
4. **Appuyez a nouveau sur Ctrl+Shift+V** pour arreter
5. **Attendez** le traitement (badge orange)
6. **Le texte nettoye** sera automatiquement insere

## Personnaliser le raccourci clavier

1. Allez a `chrome://extensions/shortcuts`
2. Trouvez "Voice to Text - n8n"
3. Cliquez sur le crayon pour modifier le raccourci

## Architecture technique

### Extension Chrome (Manifest V3)

- **background.js** : Service worker qui gere la communication avec n8n
- **content.js** : Script injecte dans les pages pour capturer l'audio et inserer le texte
- **popup.js** : Interface de configuration

### Workflow n8n

```
Webhook → Is Test? → [Test OK]
              ↓
        Prepare Audio → Mistral STT → Check Result → Mistral Cleanup → Format → Response
```

1. **Webhook** : Recoit l'audio en base64
2. **Prepare Audio** : Convertit en format binaire pour l'API
3. **Mistral STT** : Transcription avec Voxtral
4. **Mistral Cleanup** : Nettoyage avec mistral-small-latest
5. **Response** : Retourne le texte nettoye en JSON

### Prompt de nettoyage

Le prompt systeme pour le nettoyage est :

> Tu es un assistant qui transforme des transcriptions orales en prompts ecrits professionnels. Regles : retire les hesitations, repetitions, et tics de langage. Structure en phrases claires. Conserve l'intention et le ton. Ajoute une ponctuation appropriee. Ne change pas le fond, optimise la forme. Reponds uniquement avec le texte nettoye, sans commentaires ni explications.

## Depannage

### L'extension ne capture pas l'audio

- Verifiez que le site a l'autorisation d'acceder au microphone
- Chrome doit demander l'autorisation au premier usage

### Erreur de connexion au webhook

- Verifiez que n8n est lance et le workflow active
- Verifiez que l'URL du webhook est correcte
- Testez avec le bouton "Tester la connexion"

### Le texte n'est pas insere

- Assurez-vous que le curseur est dans un champ editable
- Certains sites avec des editeurs custom peuvent ne pas etre compatibles
- Le texte sera copie dans le presse-papier en fallback

### Erreur de transcription

- Verifiez votre cle API Mistral
- Assurez-vous que vous avez acces a l'API audio de Mistral
- Consultez les logs n8n pour plus de details

## Couts API Mistral

- **Transcription (Voxtral)** : ~0.01€ par minute d'audio
- **Nettoyage (mistral-small)** : ~0.0002€ par 1000 tokens

## Licence

MIT
