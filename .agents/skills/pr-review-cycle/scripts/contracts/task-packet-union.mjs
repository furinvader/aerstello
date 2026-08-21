import { unionValidationSelections } from './targeted-validation.mjs';
import { validateTaskPacket } from './task-packet.mjs';

export function unionRequiredValidation(taskPackets) {
  if (!Array.isArray(taskPackets)) throw new TypeError('taskPackets must be an array');
  taskPackets.forEach((packet, index) => {
    const errors = validateTaskPacket(packet);
    if (errors.length > 0) throw new TypeError(`Invalid task packet ${index}: ${errors.join('; ')}`);
  });
  return unionValidationSelections(taskPackets);
}
