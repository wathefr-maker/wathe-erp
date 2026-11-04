// Copie versionnée de la fonction Supabase « shopify-webhook » (v24).
// verify_jwt = FALSE : Shopify n'envoie pas de jeton Supabase, l'authentification
// se fait par signature HMAC. Redéployer sans ce réglage casse le webhook.
//
// Le corps de la fonction vit sur Supabase ; ce fichier existe pour que le
// « pourquoi » survive dans l'historique du dépôt. Voir le commit associé.
//
// EN UN MOT : cette fonction portait sa propre copie de la requête GraphQL des
// commandes, divergée de celle de shopify-orders, et elle REMPLAÇAIT la ligne
// de cache — donc elle avait toujours le dernier mot. Elle effaçait à chaque
// notification Shopify le téléphone du destinataire, la référence de variante
// (varSku) et les montants en devise client, et écrivait totalTTC dans la
// devise du client au lieu de l'euro encaissé.
// Elle appelle désormais shopify-orders. Une seule requête dans le projet.
