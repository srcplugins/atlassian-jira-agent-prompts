import Resolver from '@forge/resolver';
import api, { route, getAppContext } from '@forge/api';
import { kvs, Filter, FilterConditions } from '@forge/kvs';
import { registerResolvers, registerRovo } from './integration';
const sdk = {
  Resolver,
  api,
  route,
  kvs,
  Filter,
  FilterConditions,
  fieldType: () => {
    const c = getAppContext();
    return `ari:cloud:ecosystem::extension/${c.appAri.appId}/${c.environmentAri.environmentId}/static/native-prompts-field`;
  },
};
export const handler = registerResolvers(sdk);
export const searchPrompts = registerRovo(sdk);
