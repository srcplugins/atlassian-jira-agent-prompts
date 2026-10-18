import Resolver from '@forge/resolver';
import api, { route, getAppContext } from '@forge/api';
import { kvs, Filter, FilterConditions } from '@forge/kvs';
import { registerResolvers, registerRovo } from './integration';
import { fieldType } from './names';
const sdk = {
  Resolver,
  api,
  route,
  kvs,
  Filter,
  FilterConditions,
  fieldType: () => {
    const c = getAppContext();
    return fieldType(c.appAri.appId, c.environmentAri.environmentId);
  },
};
export const handler = registerResolvers(sdk);
export const searchPrompts = registerRovo(sdk);
