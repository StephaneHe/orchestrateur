import ssh2pkg from 'ssh2';
const { utils } = ssh2pkg;

const authorizedKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFcS51/nVPCEmaNlkB+YFZa9zv2UvIPR3fzoYtguZebs';

const parsed = utils.parseKey(authorizedKey);
console.log('parseKey(line):', parsed instanceof Error ? 'ERROR: ' + parsed.message : 'OK type=' + parsed.type);

// ctx.key.data = wire format bytes = base64-decoded second field
const wireBase64 = authorizedKey.split(' ')[1];
const wireBytes = Buffer.from(wireBase64, 'base64');
const parsedFromWire = utils.parseKey(wireBytes);
console.log('parseKey(wireBytes):', parsedFromWire instanceof Error ? 'ERROR: ' + parsedFromWire.message : 'OK type=' + parsedFromWire.type);

if (!(parsed instanceof Error) && !(parsedFromWire instanceof Error)) {
  console.log('keys match:', parsed.getPublicSSH().equals(parsedFromWire.getPublicSSH()));
}
