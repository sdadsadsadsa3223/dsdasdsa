/*
  Telegram Mini App settings.

  contactPhone: Telegram phone number used for the fallback contact link.
  botUsername: public username of the manager's Telegram account.
  orderEndpoint: leave empty when orders are sent as a prefilled direct message.

  Do not put a Telegram bot token here. A token belongs on the server only.
  The customer still confirms the message by pressing Telegram's Send button.
*/
window.ALAI_TELEGRAM={
  contactPhone:'+996880560570',
  botUsername:'alairustam',
  orderEndpoint:'',
  profileEndpoint:'/api/profile',
  useBot:false
};
