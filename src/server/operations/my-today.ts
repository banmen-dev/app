import { myToday } from '../../shared/operations/organization/my-today.ts';
import { implement } from './implement.ts';

export const myTodayOperation = implement(myToday, async ({ account }) => account.today());
