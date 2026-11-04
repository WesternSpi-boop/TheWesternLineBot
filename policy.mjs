export const normalise = s=>String(s).normalize('NFKC').replace(/^[^A-Za-z0-9]+/u,'').replace(/^[|│\s]+/u,'').trim().toLowerCase();
export const isManagement=(member,roles,ownerId)=>member.id===ownerId || member.roles.cache.has(roles.owner.id) || member.roles.cache.has(roles.management.id);
export const ticketStaff=(member,roles,ownerId)=>isManagement(member,roles,ownerId)||['admin','moderator','support'].some(k=>member.roles.cache.has(roles[k].id));
export function validateRoleAssignment(actor,target,role,roles,ownerId){
 if(!isManagement(actor,roles,ownerId))return 'Only management and ownership can assign roles.';
 if(role.managed||role.id===role.guild.id)return 'That role cannot be assigned.';
 if(role.id===roles.owner.id)return 'Ownership changes must be made by the server owner in Discord.';
 if(actor.id!==ownerId && (role.position>=actor.roles.highest.position || target.roles.highest.position>=actor.roles.highest.position))return 'You cannot change equal or higher roles or members.';
 return null;
}
